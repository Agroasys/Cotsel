import { pool } from './connection';
import {
  BankPayoutConfirmation,
  BankPayoutConfirmationUpsertInput,
  FiatDepositEvent,
  FiatDepositReference,
  FiatDepositUpsertInput,
  LedgerEntry,
  LedgerEntryWithState,
  PayoutLifecycleEvent,
  PayoutState,
  TreasuryComponent,
} from '../types';
import { createPostgresNonceStore } from '@agroasys/shared-auth';
import {
  assertBankPayoutTransition,
  BankPayoutConflictError,
  createBankPayoutPayloadHash,
  normalizeBankPayoutConfirmationInput,
} from '../core/bankPayout';
import {
  createFiatDepositPayloadHash,
  deriveFiatDepositFailureClass,
  FiatDepositConflictError,
  normalizeFiatDepositInput,
} from '../core/fiatDeposit';

const INGESTION_CURSOR_NAME = 'trade_events';
const serviceAuthNonceStore = createPostgresNonceStore({
  tableName: 'treasury_auth_nonces',
  query: (sql, params) => pool.query(sql, params),
});

export async function getIngestionOffset(
  cursorName: string = INGESTION_CURSOR_NAME,
): Promise<number> {
  const result = await pool.query<{ next_offset: number }>(
    `SELECT next_offset
     FROM treasury_ingestion_state
     WHERE cursor_name = $1`,
    [cursorName],
  );

  if (result.rows[0]) {
    return Number(result.rows[0].next_offset);
  }

  await pool.query(
    `INSERT INTO treasury_ingestion_state (cursor_name, next_offset)
     VALUES ($1, 0)
     ON CONFLICT (cursor_name) DO NOTHING`,
    [cursorName],
  );

  return 0;
}

export async function setIngestionOffset(
  nextOffset: number,
  cursorName: string = INGESTION_CURSOR_NAME,
): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_ingestion_state (cursor_name, next_offset, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_name)
     DO UPDATE SET
       next_offset = EXCLUDED.next_offset,
       updated_at = NOW()`,
    [cursorName, nextOffset],
  );
}

export async function consumeServiceAuthNonce(
  apiKey: string,
  nonce: string,
  ttlSeconds: number,
): Promise<boolean> {
  return serviceAuthNonceStore.consume(apiKey, nonce, ttlSeconds);
}

export async function upsertLedgerEntryWithInitialState(data: {
  entryKey: string;
  tradeId: string;
  txHash: string;
  blockNumber: number;
  eventName: string;
  componentType: TreasuryComponent;
  amountRaw: string;
  sourceTimestamp: Date;
  metadata: Record<string, unknown>;
  initialStateNote?: string;
  initialStateActor?: string;
}): Promise<{ entry: LedgerEntry; initialStateCreated: boolean }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const entryResult = await client.query<LedgerEntry>(
      `INSERT INTO treasury_ledger_entries (
          entry_key,
          trade_id,
          tx_hash,
          block_number,
          event_name,
          component_type,
          amount_raw,
          source_timestamp,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (entry_key)
        DO UPDATE SET
          trade_id = EXCLUDED.trade_id,
          tx_hash = EXCLUDED.tx_hash,
          block_number = EXCLUDED.block_number,
          event_name = EXCLUDED.event_name,
          component_type = EXCLUDED.component_type,
          amount_raw = EXCLUDED.amount_raw,
          source_timestamp = EXCLUDED.source_timestamp,
          metadata = EXCLUDED.metadata
        RETURNING *`,
      [
        data.entryKey,
        data.tradeId,
        data.txHash,
        data.blockNumber,
        data.eventName,
        data.componentType,
        data.amountRaw,
        data.sourceTimestamp,
        JSON.stringify(data.metadata),
      ],
    );

    const entry = entryResult.rows[0];

    const initialStateResult = await client.query(
      `INSERT INTO payout_lifecycle_events (
          ledger_entry_id,
          state,
          note,
          actor
        )
        SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (
          SELECT 1
          FROM payout_lifecycle_events
          WHERE ledger_entry_id = $1
        )`,
      [
        entry.id,
        'PENDING_REVIEW',
        data.initialStateNote || 'Auto-created from indexer ingestion',
        data.initialStateActor || 'system:indexer-ingest',
      ],
    );

    await client.query('COMMIT');

    return {
      entry,
      initialStateCreated: (initialStateResult.rowCount ?? 0) > 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function appendPayoutState(data: {
  ledgerEntryId: number;
  state: PayoutState;
  note?: string;
  actor?: string;
}): Promise<PayoutLifecycleEvent> {
  const result = await pool.query<PayoutLifecycleEvent>(
    `INSERT INTO payout_lifecycle_events (
      ledger_entry_id,
      state,
      note,
      actor
    ) VALUES ($1, $2, $3, $4)
    RETURNING *`,
    [data.ledgerEntryId, data.state, data.note || null, data.actor || null],
  );

  return result.rows[0];
}

export async function getLatestPayoutState(
  ledgerEntryId: number,
): Promise<PayoutLifecycleEvent | null> {
  const result = await pool.query<PayoutLifecycleEvent>(
    `SELECT *
     FROM payout_lifecycle_events
     WHERE ledger_entry_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [ledgerEntryId],
  );

  return result.rows[0] || null;
}

export async function getLatestBankPayoutConfirmation(
  ledgerEntryId: number,
): Promise<BankPayoutConfirmation | null> {
  const result = await pool.query<BankPayoutConfirmation>(
    `SELECT *
     FROM bank_payout_confirmations
     WHERE ledger_entry_id = $1
     ORDER BY confirmed_at DESC, id DESC
     LIMIT 1`,
    [ledgerEntryId],
  );

  return result.rows[0] || null;
}

export async function getLedgerEntries(params: {
  tradeId?: string;
  state?: PayoutState;
  limit: number;
  offset: number;
}): Promise<LedgerEntryWithState[]> {
  const values: Array<string | number> = [];
  const filters: string[] = [];

  if (params.tradeId) {
    values.push(params.tradeId);
    filters.push(`e.trade_id = $${values.length}`);
  }

  if (params.state) {
    values.push(params.state);
    filters.push(`s.state = $${values.length}`);
  }

  values.push(params.limit);
  const limitParam = `$${values.length}`;

  values.push(params.offset);
  const offsetParam = `$${values.length}`;

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const result = await pool.query<LedgerEntryWithState>(
    `SELECT
        e.*,
        s.state AS latest_state,
        s.created_at AS latest_state_at
      FROM treasury_ledger_entries e
      JOIN LATERAL (
        SELECT p.state, p.created_at
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) s ON TRUE
      ${whereClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );

  return result.rows;
}

export async function getLedgerEntryById(entryId: number): Promise<LedgerEntry | null> {
  const result = await pool.query<LedgerEntry>(
    'SELECT * FROM treasury_ledger_entries WHERE id = $1',
    [entryId],
  );

  return result.rows[0] || null;
}

export async function getLedgerEntryByTradeId(tradeId: string): Promise<LedgerEntry | null> {
  const result = await pool.query<LedgerEntry>(
    `SELECT *
     FROM treasury_ledger_entries
     WHERE trade_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [tradeId],
  );

  return result.rows[0] || null;
}

export async function getFiatDepositByProviderEventId(
  providerEventId: string,
): Promise<FiatDepositReference | null> {
  const result = await pool.query<FiatDepositReference>(
    `SELECT *
     FROM fiat_deposit_references
     WHERE provider_event_id = $1`,
    [providerEventId],
  );

  return result.rows[0] || null;
}

export async function upsertFiatDepositReference(data: FiatDepositUpsertInput): Promise<{
  reference: FiatDepositReference;
  eventCreated: boolean;
  idempotentReplay: boolean;
}> {
  const normalized = normalizeFiatDepositInput(data);
  const payloadHash = createFiatDepositPayloadHash(normalized);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingEvent = await client.query<{
      payload_hash: string;
      fiat_deposit_reference_id: number;
    }>(
      `SELECT payload_hash, fiat_deposit_reference_id
       FROM fiat_deposit_events
       WHERE provider_event_id = $1`,
      [normalized.providerEventId],
    );

    if (existingEvent.rows[0]) {
      if (existingEvent.rows[0].payload_hash !== payloadHash) {
        throw new FiatDepositConflictError('Duplicate provider event with conflicting payload');
      }

      const existingReference = await client.query<FiatDepositReference>(
        `SELECT *
         FROM fiat_deposit_references
         WHERE id = $1`,
        [existingEvent.rows[0].fiat_deposit_reference_id],
      );

      await client.query('COMMIT');
      return {
        reference: existingReference.rows[0],
        eventCreated: false,
        idempotentReplay: true,
      };
    }

    let matchedLedgerEntry: LedgerEntry | null = null;
    if (normalized.ledgerEntryId !== null) {
      const ledgerEntryResult = await client.query<LedgerEntry>(
        `SELECT *
         FROM treasury_ledger_entries
         WHERE id = $1`,
        [normalized.ledgerEntryId],
      );
      matchedLedgerEntry = ledgerEntryResult.rows[0] || null;
    } else {
      const tradeLedgerResult = await client.query<LedgerEntry>(
        `SELECT *
         FROM treasury_ledger_entries
         WHERE trade_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [normalized.tradeId],
      );
      matchedLedgerEntry = tradeLedgerResult.rows[0] || null;
    }

    const canonicalLedgerEntry =
      matchedLedgerEntry && matchedLedgerEntry.trade_id === normalized.tradeId
        ? matchedLedgerEntry
        : null;
    const ledgerEntryId = canonicalLedgerEntry ? canonicalLedgerEntry.id : null;
    const failureClass = deriveFiatDepositFailureClass(normalized, canonicalLedgerEntry);

    const existingReference = await client.query<{ id: number; trade_id: string }>(
      `SELECT id, trade_id
       FROM fiat_deposit_references
       WHERE ramp_reference = $1`,
      [normalized.rampReference],
    );

    if (existingReference.rows[0] && existingReference.rows[0].trade_id !== normalized.tradeId) {
      throw new FiatDepositConflictError('Ramp reference already belongs to a different trade');
    }

    const referenceResult = await client.query<FiatDepositReference>(
      `INSERT INTO fiat_deposit_references (
          ramp_reference,
          trade_id,
          ledger_entry_id,
          deposit_state,
          source_amount,
          currency,
          expected_amount,
          expected_currency,
          observed_at,
          provider_event_id,
          provider_account_ref,
          failure_class,
          failure_code,
          reversal_reference,
          latest_event_payload_hash,
          metadata,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16::jsonb, NOW()
        )
        ON CONFLICT (ramp_reference)
        DO UPDATE SET
          trade_id = EXCLUDED.trade_id,
          ledger_entry_id = EXCLUDED.ledger_entry_id,
          deposit_state = EXCLUDED.deposit_state,
          source_amount = EXCLUDED.source_amount,
          currency = EXCLUDED.currency,
          expected_amount = EXCLUDED.expected_amount,
          expected_currency = EXCLUDED.expected_currency,
          observed_at = EXCLUDED.observed_at,
          provider_event_id = EXCLUDED.provider_event_id,
          provider_account_ref = EXCLUDED.provider_account_ref,
          failure_class = EXCLUDED.failure_class,
          failure_code = EXCLUDED.failure_code,
          reversal_reference = EXCLUDED.reversal_reference,
          latest_event_payload_hash = EXCLUDED.latest_event_payload_hash,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *`,
      [
        normalized.rampReference,
        normalized.tradeId,
        ledgerEntryId,
        normalized.depositState,
        normalized.sourceAmount,
        normalized.currency,
        normalized.expectedAmount,
        normalized.expectedCurrency,
        normalized.observedAt,
        normalized.providerEventId,
        normalized.providerAccountRef,
        failureClass,
        normalized.failureCode,
        normalized.reversalReference,
        payloadHash,
        JSON.stringify(normalized.metadata ?? {}),
      ],
    );

    const reference = referenceResult.rows[0];

    await client.query<FiatDepositEvent>(
      `INSERT INTO fiat_deposit_events (
          fiat_deposit_reference_id,
          ramp_reference,
          trade_id,
          ledger_entry_id,
          deposit_state,
          source_amount,
          currency,
          expected_amount,
          expected_currency,
          observed_at,
          provider_event_id,
          provider_account_ref,
          failure_class,
          failure_code,
          reversal_reference,
          payload_hash,
          metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17::jsonb
        )`,
      [
        reference.id,
        normalized.rampReference,
        normalized.tradeId,
        ledgerEntryId,
        normalized.depositState,
        normalized.sourceAmount,
        normalized.currency,
        normalized.expectedAmount,
        normalized.expectedCurrency,
        normalized.observedAt,
        normalized.providerEventId,
        normalized.providerAccountRef,
        failureClass,
        normalized.failureCode,
        normalized.reversalReference,
        payloadHash,
        JSON.stringify(normalized.metadata ?? {}),
      ],
    );

    await client.query('COMMIT');

    return {
      reference,
      eventCreated: true,
      idempotentReplay: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertBankPayoutConfirmation(
  data: BankPayoutConfirmationUpsertInput,
): Promise<{
  confirmation: BankPayoutConfirmation;
  created: boolean;
  idempotentReplay: boolean;
}> {
  const normalized = normalizeBankPayoutConfirmationInput(data);
  const payloadHash = createBankPayoutPayloadHash(normalized);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingByReference = await client.query<BankPayoutConfirmation>(
      `SELECT *
       FROM bank_payout_confirmations
       WHERE bank_reference = $1`,
      [normalized.bankReference],
    );

    if (existingByReference.rows[0]) {
      if (existingByReference.rows[0].payload_hash !== payloadHash) {
        throw new BankPayoutConflictError('Duplicate bank reference with conflicting payload');
      }

      await client.query('COMMIT');
      return {
        confirmation: existingByReference.rows[0],
        created: false,
        idempotentReplay: true,
      };
    }

    const ledgerEntryResult = await client.query<LedgerEntry>(
      `SELECT *
       FROM treasury_ledger_entries
       WHERE id = $1`,
      [normalized.ledgerEntryId],
    );

    const ledgerEntry = ledgerEntryResult.rows[0];
    if (!ledgerEntry) {
      throw new Error('Ledger entry not found');
    }

    const payoutStateResult = await client.query<PayoutLifecycleEvent>(
      `SELECT *
       FROM payout_lifecycle_events
       WHERE ledger_entry_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [normalized.ledgerEntryId],
    );

    const latestPayoutState = payoutStateResult.rows[0];
    assertBankPayoutTransition(latestPayoutState?.state ?? 'PENDING_REVIEW', normalized.bankState);

    const result = await client.query<BankPayoutConfirmation>(
      `INSERT INTO bank_payout_confirmations (
          ledger_entry_id,
          payout_reference,
          bank_reference,
          bank_state,
          confirmed_at,
          source,
          actor,
          failure_code,
          evidence_reference,
          payload_hash,
          metadata
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11::jsonb
        )
        RETURNING *`,
      [
        normalized.ledgerEntryId,
        normalized.payoutReference,
        normalized.bankReference,
        normalized.bankState,
        normalized.confirmedAt,
        normalized.source,
        normalized.actor,
        normalized.failureCode,
        normalized.evidenceReference,
        payloadHash,
        JSON.stringify(normalized.metadata ?? {}),
      ],
    );

    await client.query('COMMIT');

    return {
      confirmation: result.rows[0],
      created: true,
      idempotentReplay: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
