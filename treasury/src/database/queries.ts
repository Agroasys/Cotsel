import { createHash } from 'node:crypto';
import { pool } from './connection';
import {
  AccountingPeriod,
  AccountingPeriodStatus,
  BankPayoutConfirmation,
  BankPayoutConfirmationUpsertInput,
  FiatDepositEvent,
  FiatDepositReference,
  FiatDepositUpsertInput,
  LedgerEntryAccountingFacts,
  LedgerEntry,
  LedgerEntryWithState,
  PayoutLifecycleEvent,
  PayoutState,
  TreasuryPartnerHandoff,
  TreasuryPartnerHandoffEvidenceInput,
  TreasuryPartnerHandoffEvent,
  TreasuryPartnerHandoffInput,
  PartnerHandoff,
  PartnerHandoffStatus,
  RevenueRealization,
  SweepBatch,
  SweepBatchDetail,
  SweepBatchEntry,
  SweepBatchStatus,
  SweepBatchWithPeriod,
  TreasuryClaimEvent,
  TreasuryAccountingState,
  TreasuryComponent,
} from '../types';
import { createPostgresNonceStore } from '@agroasys/shared-auth';
import {
  assertAccountingPeriodTransition,
  assertBatchAllocationAllowed,
  assertRealizationAllowed,
  assertSweepBatchRoleSeparation,
  assertSweepBatchTransition,
} from '../core/accountingPolicy';
import {
  assertBankPayoutTransition,
  BankPayoutConflictError,
  createBankPayoutPayloadHash,
  normalizeBankPayoutConfirmationInput,
} from '../core/bankPayout';
import { projectLedgerEntryAccountingState } from '../core/accountingStateProjection';
import {
  createFiatDepositPayloadHash,
  deriveFiatDepositFailureClass,
  FiatDepositConflictError,
  normalizeFiatDepositInput,
} from '../core/fiatDeposit';
import { sumAllocatedEntryAmountRaw } from '../core/sweepBatchAmounts';

const INGESTION_CURSOR_NAME = 'trade_events';
const serviceAuthNonceStore = createPostgresNonceStore({
  tableName: 'treasury_auth_nonces',
  query: (sql, params) => pool.query(sql, params),
});

function createPayloadHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function createPartnerHandoffPayloadHash(input: {
  sweepBatchId: number;
  partnerName: string;
  partnerReference: string;
  handoffStatus: PartnerHandoffStatus;
  evidenceReference: string | null;
  metadata: Record<string, unknown>;
}): string {
  const serialized = JSON.stringify({
    sweepBatchId: input.sweepBatchId,
    partnerName: input.partnerName,
    partnerReference: input.partnerReference,
    handoffStatus: input.handoffStatus,
    evidenceReference: input.evidenceReference,
    metadata: input.metadata,
  });

  return createHash('sha256').update(serialized).digest('hex');
}

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

export async function listDistinctLedgerTradeIds(): Promise<string[]> {
  const result = await pool.query<{ trade_id: string }>(
    `SELECT DISTINCT trade_id
     FROM treasury_ledger_entries
     ORDER BY trade_id ASC`,
  );

  return result.rows.map((row) => row.trade_id.trim()).filter((tradeId) => tradeId.length > 0);
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

export async function createAccountingPeriod(data: {
  periodKey: string;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  metadata?: Record<string, unknown>;
}): Promise<AccountingPeriod> {
  const result = await pool.query<AccountingPeriod>(
    `INSERT INTO accounting_periods (
        period_key,
        starts_at,
        ends_at,
        status,
        created_by,
        metadata,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      RETURNING *`,
    [
      data.periodKey,
      data.startsAt,
      data.endsAt,
      'OPEN',
      data.createdBy,
      JSON.stringify(data.metadata ?? {}),
    ],
  );

  return result.rows[0];
}

export async function listAccountingPeriods(params: {
  status?: AccountingPeriodStatus;
  limit: number;
  offset: number;
}): Promise<AccountingPeriod[]> {
  const values: Array<string | number> = [];
  const filters: string[] = [];

  if (params.status) {
    values.push(params.status);
    filters.push(`status = $${values.length}`);
  }

  values.push(params.limit);
  const limitParam = `$${values.length}`;
  values.push(params.offset);
  const offsetParam = `$${values.length}`;
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const result = await pool.query<AccountingPeriod>(
    `SELECT *
     FROM accounting_periods
     ${whereClause}
     ORDER BY starts_at DESC, id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );

  return result.rows;
}

export async function getAccountingPeriodById(id: number): Promise<AccountingPeriod | null> {
  const result = await pool.query<AccountingPeriod>(
    `SELECT *
     FROM accounting_periods
     WHERE id = $1`,
    [id],
  );

  return result.rows[0] || null;
}

export async function updateAccountingPeriodStatus(data: {
  periodId: number;
  status: AccountingPeriodStatus;
  actor: string;
  closeReason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AccountingPeriod> {
  const existing = await getAccountingPeriodById(data.periodId);
  if (!existing) {
    throw new Error('Accounting period not found');
  }

  assertAccountingPeriodTransition(existing.status, data.status);

  const pendingCloseAt = data.status === 'PENDING_CLOSE' ? new Date() : existing.pending_close_at;
  const closedAt = data.status === 'CLOSED' ? new Date() : existing.closed_at;
  const closedBy = data.status === 'CLOSED' ? data.actor : existing.closed_by;

  const result = await pool.query<AccountingPeriod>(
    `UPDATE accounting_periods
     SET status = $2,
         close_reason = COALESCE($3, close_reason),
         pending_close_at = $4,
         closed_at = $5,
         closed_by = $6,
         metadata = CASE
           WHEN $7::jsonb = '{}'::jsonb THEN metadata
           ELSE metadata || $7::jsonb
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      data.periodId,
      data.status,
      data.closeReason ?? null,
      pendingCloseAt,
      closedAt,
      closedBy,
      JSON.stringify(data.metadata ?? {}),
    ],
  );

  return result.rows[0];
}

export async function createSweepBatch(data: {
  batchKey: string;
  accountingPeriodId: number;
  assetSymbol: string;
  expectedTotalRaw: string;
  payoutReceiverAddress?: string | null;
  createdBy: string;
  metadata?: Record<string, unknown>;
}): Promise<SweepBatch> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const periodResult = await client.query<AccountingPeriod>(
      `SELECT *
       FROM accounting_periods
       WHERE id = $1`,
      [data.accountingPeriodId],
    );
    const period = periodResult.rows[0];

    if (!period) {
      throw new Error('Accounting period not found');
    }

    if (period.status !== 'OPEN') {
      throw new Error(
        `Sweep batch creation requires an OPEN accounting period; received ${period.status}`,
      );
    }

    const result = await client.query<SweepBatch>(
      `INSERT INTO sweep_batches (
          batch_key,
          accounting_period_id,
          asset_symbol,
          status,
          expected_total_raw,
          payout_receiver_address,
          created_by,
          metadata,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
        RETURNING *`,
      [
        data.batchKey,
        data.accountingPeriodId,
        data.assetSymbol,
        'DRAFT',
        data.expectedTotalRaw,
        data.payoutReceiverAddress ?? null,
        data.createdBy,
        JSON.stringify(data.metadata ?? {}),
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getSweepBatchById(id: number): Promise<SweepBatch | null> {
  const result = await pool.query<SweepBatch>(
    `SELECT *
     FROM sweep_batches
     WHERE id = $1`,
    [id],
  );

  return result.rows[0] || null;
}

export async function listSweepBatches(params: {
  accountingPeriodId?: number;
  status?: SweepBatchStatus;
  limit: number;
  offset: number;
}): Promise<SweepBatchWithPeriod[]> {
  const values: Array<string | number> = [];
  const filters: string[] = [];

  if (params.accountingPeriodId !== undefined) {
    values.push(params.accountingPeriodId);
    filters.push(`b.accounting_period_id = $${values.length}`);
  }

  if (params.status) {
    values.push(params.status);
    filters.push(`b.status = $${values.length}`);
  }

  values.push(params.limit);
  const limitParam = `$${values.length}`;
  values.push(params.offset);
  const offsetParam = `$${values.length}`;
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const result = await pool.query<SweepBatchWithPeriod>(
    `SELECT
        b.*,
        p.period_key AS accounting_period_key,
        p.status AS accounting_period_status
      FROM sweep_batches b
      JOIN accounting_periods p ON p.id = b.accounting_period_id
      ${whereClause}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );

  return result.rows;
}

export async function getPartnerHandoffByBatchId(batchId: number): Promise<PartnerHandoff | null> {
  const result = await pool.query<PartnerHandoff>(
    `SELECT *
     FROM partner_handoffs
     WHERE sweep_batch_id = $1`,
    [batchId],
  );

  return result.rows[0] || null;
}

export async function getTreasuryClaimEventByBatchId(
  batchId: number,
): Promise<TreasuryClaimEvent | null> {
  const result = await pool.query<TreasuryClaimEvent>(
    `SELECT *
     FROM treasury_claim_events
     WHERE matched_sweep_batch_id = $1`,
    [batchId],
  );

  return result.rows[0] || null;
}

export async function getTreasuryClaimEventByTxHash(
  txHash: string,
): Promise<TreasuryClaimEvent | null> {
  const result = await pool.query<TreasuryClaimEvent>(
    `SELECT *
     FROM treasury_claim_events
     WHERE tx_hash = $1`,
    [txHash],
  );

  return result.rows[0] || null;
}

export async function getSweepBatchDetail(batchId: number): Promise<SweepBatchDetail | null> {
  const batchResult = await pool.query<SweepBatchWithPeriod>(
    `SELECT
        b.*,
        p.period_key AS accounting_period_key,
        p.status AS accounting_period_status
      FROM sweep_batches b
      JOIN accounting_periods p ON p.id = b.accounting_period_id
      WHERE b.id = $1`,
    [batchId],
  );

  const batch = batchResult.rows[0];
  if (!batch) {
    return null;
  }

  const [links, partnerHandoff] = await Promise.all([
    (async () => {
      const allocations = await listSweepBatchEntries(batchId);
      const projections = await Promise.all(
        allocations.map((link) => getLedgerEntryAccountingProjection(link.ledger_entry_id)),
      );
      return allocations
        .map((link, index) => {
          const projection = projections[index];
          return projection ? { ...projection, allocated_amount_raw: link.entry_amount_raw } : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    })(),
    getPartnerHandoffByBatchId(batchId),
  ]);

  const allocatedAmountRaw = sumAllocatedEntryAmountRaw(links);

  return {
    batch,
    entries: links,
    partnerHandoff,
    totals: {
      allocatedAmountRaw,
      entryCount: links.length,
    },
  };
}

export async function updateSweepBatchStatus(data: {
  batchId: number;
  status: SweepBatchStatus;
  actor: string;
  matchedSweepTxHash?: string | null;
  matchedSweepBlockNumber?: string | null;
  matchedSweptAt?: Date | null;
  metadata?: Record<string, unknown>;
}): Promise<SweepBatch> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingResult = await client.query<SweepBatch>(
      `SELECT *
       FROM sweep_batches
       WHERE id = $1`,
      [data.batchId],
    );
    const existing = existingResult.rows[0];

    if (!existing) {
      throw new Error('Sweep batch not found');
    }

    assertSweepBatchTransition(existing.status, data.status);
    assertSweepBatchRoleSeparation({
      nextStatus: data.status,
      actor: data.actor,
      createdBy: existing.created_by,
      approvalRequestedBy: existing.approval_requested_by,
      approvedBy: existing.approved_by,
      executedBy: existing.executed_by,
    });

    const approvalRequestedAt =
      data.status === 'PENDING_APPROVAL' ? new Date() : existing.approval_requested_at;
    const approvalRequestedBy =
      data.status === 'PENDING_APPROVAL' ? data.actor : existing.approval_requested_by;
    const approvedAt = data.status === 'APPROVED' ? new Date() : existing.approved_at;
    const approvedBy = data.status === 'APPROVED' ? data.actor : existing.approved_by;
    const executedBy = data.status === 'EXECUTED' ? data.actor : existing.executed_by;
    const closedAt = data.status === 'CLOSED' ? new Date() : existing.closed_at;
    const closedBy = data.status === 'CLOSED' ? data.actor : existing.closed_by;

    const result = await client.query<SweepBatch>(
      `UPDATE sweep_batches
       SET status = $2,
           approval_requested_at = $3,
           approval_requested_by = $4,
           approved_at = $5,
           approved_by = $6,
           matched_sweep_tx_hash = COALESCE($7, matched_sweep_tx_hash),
           matched_sweep_block_number = COALESCE($8, matched_sweep_block_number),
           matched_swept_at = COALESCE($9, matched_swept_at),
           executed_by = $10,
           closed_at = $11,
           closed_by = $12,
           metadata = CASE
             WHEN $13::jsonb = '{}'::jsonb THEN metadata
             ELSE metadata || $13::jsonb
           END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        data.batchId,
        data.status,
        approvalRequestedAt,
        approvalRequestedBy,
        approvedAt,
        approvedBy,
        data.matchedSweepTxHash ?? null,
        data.matchedSweepBlockNumber ?? null,
        data.matchedSweptAt ?? null,
        executedBy,
        closedAt,
        closedBy,
        JSON.stringify(data.metadata ?? {}),
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function addSweepBatchEntry(data: {
  sweepBatchId: number;
  ledgerEntryId: number;
  allocatedBy: string;
  entryAmountRaw?: string;
}): Promise<SweepBatchEntry> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const batchResult = await client.query<
      SweepBatch & { accounting_period_status: AccountingPeriodStatus }
    >(
      `SELECT b.*, p.status AS accounting_period_status
       FROM sweep_batches b
       JOIN accounting_periods p ON p.id = b.accounting_period_id
       WHERE b.id = $1`,
      [data.sweepBatchId],
    );
    const batch = batchResult.rows[0];

    if (!batch) {
      throw new Error('Sweep batch not found');
    }

    assertBatchAllocationAllowed({
      periodStatus: batch.accounting_period_status,
      batchStatus: batch.status,
    });

    const ledgerEntryResult = await client.query<LedgerEntry>(
      `SELECT *
       FROM treasury_ledger_entries
       WHERE id = $1`,
      [data.ledgerEntryId],
    );
    const ledgerEntry = ledgerEntryResult.rows[0];

    if (!ledgerEntry) {
      throw new Error('Ledger entry not found');
    }

    const existingAllocation = await client.query<SweepBatchEntry>(
      `SELECT *
       FROM sweep_batch_entries
       WHERE ledger_entry_id = $1
         AND allocation_status = 'ALLOCATED'`,
      [data.ledgerEntryId],
    );

    if (existingAllocation.rows[0]) {
      throw new Error('Ledger entry is already allocated to an active sweep batch');
    }

    const result = await client.query<SweepBatchEntry>(
      `INSERT INTO sweep_batch_entries (
          sweep_batch_id,
          ledger_entry_id,
          allocation_status,
          entry_amount_raw,
          allocated_by,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *`,
      [
        data.sweepBatchId,
        data.ledgerEntryId,
        'ALLOCATED',
        data.entryAmountRaw ?? ledgerEntry.amount_raw,
        data.allocatedBy,
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listSweepBatchEntries(batchId: number): Promise<SweepBatchEntry[]> {
  const result = await pool.query<SweepBatchEntry>(
    `SELECT *
     FROM sweep_batch_entries
     WHERE sweep_batch_id = $1
     ORDER BY created_at ASC, id ASC`,
    [batchId],
  );

  return result.rows;
}

export async function upsertTreasuryClaimEvent(data: {
  sourceEventId: string;
  matchedSweepBatchId?: number | null;
  txHash: string;
  blockNumber: number;
  observedAt: Date;
  treasuryIdentity: string;
  payoutReceiver: string;
  amountRaw: string;
  triggeredBy?: string | null;
}): Promise<TreasuryClaimEvent> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingByTx = await client.query<TreasuryClaimEvent>(
      `SELECT *
       FROM treasury_claim_events
       WHERE tx_hash = $1
          OR source_event_id = $2`,
      [data.txHash, data.sourceEventId],
    );

    const existing = existingByTx.rows[0];
    if (
      existing &&
      existing.matched_sweep_batch_id !== null &&
      data.matchedSweepBatchId !== undefined &&
      data.matchedSweepBatchId !== null &&
      existing.matched_sweep_batch_id !== data.matchedSweepBatchId
    ) {
      throw new Error('Treasury claim event is already matched to a different sweep batch');
    }

    const result = existing
      ? await client.query<TreasuryClaimEvent>(
          `UPDATE treasury_claim_events
           SET source_event_id = $2,
               matched_sweep_batch_id = COALESCE($3, matched_sweep_batch_id),
               tx_hash = $4,
               block_number = $5,
               observed_at = $6,
               treasury_identity = $7,
               payout_receiver = $8,
               amount_raw = $9,
               triggered_by = $10
           WHERE id = $1
           RETURNING *`,
          [
            existing.id,
            data.sourceEventId,
            data.matchedSweepBatchId ?? null,
            data.txHash,
            data.blockNumber,
            data.observedAt,
            data.treasuryIdentity,
            data.payoutReceiver,
            data.amountRaw,
            data.triggeredBy ?? null,
          ],
        )
      : await client.query<TreasuryClaimEvent>(
          `INSERT INTO treasury_claim_events (
              source_event_id,
              matched_sweep_batch_id,
              tx_hash,
              block_number,
              observed_at,
              treasury_identity,
              payout_receiver,
              amount_raw,
              triggered_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
          [
            data.sourceEventId,
            data.matchedSweepBatchId ?? null,
            data.txHash,
            data.blockNumber,
            data.observedAt,
            data.treasuryIdentity,
            data.payoutReceiver,
            data.amountRaw,
            data.triggeredBy ?? null,
          ],
        );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertPartnerHandoff(data: {
  sweepBatchId: number;
  partnerName: string;
  partnerReference: string;
  handoffStatus: PartnerHandoffStatus;
  evidenceReference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<PartnerHandoff> {
  const client = await pool.connect();
  const metadata = data.metadata ?? {};
  const payloadHash = createPartnerHandoffPayloadHash({
    sweepBatchId: data.sweepBatchId,
    partnerName: data.partnerName,
    partnerReference: data.partnerReference,
    handoffStatus: data.handoffStatus,
    evidenceReference: data.evidenceReference ?? null,
    metadata,
  });

  try {
    await client.query('BEGIN');

    const batchResult = await client.query<SweepBatch>(
      `SELECT *
       FROM sweep_batches
       WHERE id = $1`,
      [data.sweepBatchId],
    );
    const batch = batchResult.rows[0];

    if (!batch) {
      throw new Error('Sweep batch not found');
    }

    if (!batch.matched_sweep_tx_hash || !batch.matched_swept_at) {
      throw new Error('External handoff requires matched on-chain treasury claim evidence');
    }

    const timestamp = new Date();
    const result = await client.query<PartnerHandoff>(
      `INSERT INTO partner_handoffs (
          sweep_batch_id,
          partner_name,
          partner_reference,
          handoff_status,
          latest_payload_hash,
          evidence_reference,
          submitted_at,
          acknowledged_at,
          completed_at,
          failed_at,
          verified_at,
          metadata,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12::jsonb, NOW()
        )
        ON CONFLICT (sweep_batch_id)
        DO UPDATE SET
          partner_name = EXCLUDED.partner_name,
          partner_reference = EXCLUDED.partner_reference,
          handoff_status = EXCLUDED.handoff_status,
          latest_payload_hash = EXCLUDED.latest_payload_hash,
          evidence_reference = EXCLUDED.evidence_reference,
          submitted_at = COALESCE(EXCLUDED.submitted_at, partner_handoffs.submitted_at),
          acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, partner_handoffs.acknowledged_at),
          completed_at = COALESCE(EXCLUDED.completed_at, partner_handoffs.completed_at),
          failed_at = COALESCE(EXCLUDED.failed_at, partner_handoffs.failed_at),
          verified_at = COALESCE(EXCLUDED.verified_at, partner_handoffs.verified_at),
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *`,
      [
        data.sweepBatchId,
        data.partnerName,
        data.partnerReference,
        data.handoffStatus,
        payloadHash,
        data.evidenceReference ?? null,
        ['SUBMITTED', 'ACKNOWLEDGED', 'COMPLETED'].includes(data.handoffStatus) ? timestamp : null,
        ['ACKNOWLEDGED', 'COMPLETED'].includes(data.handoffStatus) ? timestamp : null,
        data.handoffStatus === 'COMPLETED' ? timestamp : null,
        data.handoffStatus === 'FAILED' ? timestamp : null,
        ['ACKNOWLEDGED', 'COMPLETED'].includes(data.handoffStatus) ? timestamp : null,
        JSON.stringify(metadata),
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createRevenueRealization(data: {
  ledgerEntryId: number;
  accountingPeriodId: number;
  sweepBatchId?: number | null;
  partnerHandoffId?: number | null;
  actor: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<RevenueRealization> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const facts = await getLedgerEntryAccountingFacts(data.ledgerEntryId, client);
    if (!facts) {
      throw new Error('Ledger entry accounting facts not found');
    }

    assertRealizationAllowed({
      batchStatus: facts.sweep_batch_status,
      partnerHandoffStatus: facts.partner_handoff_status,
      bankPayoutState: facts.latest_bank_payout_state,
      revenueRealizationStatus: facts.revenue_realization_status,
    });

    if (data.accountingPeriodId !== facts.accounting_period_id) {
      throw new Error(
        'Revenue realization accounting period does not match the ledger entry batch',
      );
    }

    if (
      data.sweepBatchId !== undefined &&
      data.sweepBatchId !== null &&
      data.sweepBatchId !== facts.sweep_batch_id
    ) {
      throw new Error('Revenue realization sweep batch does not match the ledger entry batch');
    }

    if (
      data.partnerHandoffId !== undefined &&
      data.partnerHandoffId !== null &&
      data.partnerHandoffId !== facts.partner_handoff_id
    ) {
      throw new Error(
        'Revenue realization external handoff does not match the ledger entry sweep batch',
      );
    }

    const result = await client.query<RevenueRealization>(
      `INSERT INTO revenue_realizations (
          ledger_entry_id,
          accounting_period_id,
          sweep_batch_id,
          partner_handoff_id,
          realization_status,
          realized_at,
          recognized_by,
          note,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *`,
      [
        data.ledgerEntryId,
        data.accountingPeriodId,
        data.sweepBatchId ?? facts.sweep_batch_id,
        data.partnerHandoffId ?? facts.partner_handoff_id,
        'REALIZED',
        new Date(),
        data.actor,
        data.note ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type Queryable = Pick<typeof pool, 'query'>;

export async function getLedgerEntryAccountingFacts(
  ledgerEntryId: number,
  queryable: Queryable = pool,
): Promise<LedgerEntryAccountingFacts | null> {
  const result = await queryable.query<LedgerEntryAccountingFacts>(
    `SELECT
        e.id AS ledger_entry_id,
        e.trade_id,
        e.component_type,
        e.amount_raw,
        alloc.entry_amount_raw AS allocated_amount_raw,
        alloc.created_at AS allocated_at,
        e.source_timestamp AS earned_at,
        payout.state AS payout_state,
        period.id AS accounting_period_id,
        period.period_key AS accounting_period_key,
        period.status AS accounting_period_status,
        batch.id AS sweep_batch_id,
        batch.status AS sweep_batch_status,
        alloc.allocation_status,
        claim.tx_hash AS matched_sweep_tx_hash,
        claim.block_number AS matched_sweep_block_number,
        claim.observed_at AS matched_swept_at,
        claim.treasury_identity AS matched_treasury_identity,
        claim.payout_receiver AS matched_payout_receiver,
        claim.amount_raw AS matched_claim_amount_raw,
        handoff.id AS partner_handoff_id,
        handoff.partner_name,
        handoff.partner_reference,
        handoff.handoff_status AS partner_handoff_status,
        handoff.submitted_at AS partner_submitted_at,
        handoff.acknowledged_at AS partner_acknowledged_at,
        handoff.completed_at AS partner_completed_at,
        handoff.failed_at AS partner_failed_at,
        handoff.verified_at AS partner_verified_at,
        deposit.ramp_reference AS latest_fiat_deposit_ramp_reference,
        deposit.deposit_state AS latest_fiat_deposit_state,
        deposit.failure_class AS latest_fiat_deposit_failure_class,
        deposit.observed_at AS latest_fiat_deposit_observed_at,
        bank.bank_reference AS latest_bank_reference,
        bank.bank_state AS latest_bank_payout_state,
        bank.failure_code AS latest_bank_failure_code,
        bank.confirmed_at AS latest_bank_confirmed_at,
        realization.realization_status AS revenue_realization_status,
        realization.realized_at
      FROM treasury_ledger_entries e
      LEFT JOIN LATERAL (
        SELECT p.state
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) payout ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM sweep_batch_entries sbe
        WHERE sbe.ledger_entry_id = e.id
          AND sbe.allocation_status = 'ALLOCATED'
        ORDER BY sbe.updated_at DESC, sbe.id DESC
        LIMIT 1
      ) alloc ON TRUE
      LEFT JOIN sweep_batches batch ON batch.id = alloc.sweep_batch_id
      LEFT JOIN accounting_periods period ON period.id = batch.accounting_period_id
      LEFT JOIN treasury_claim_events claim ON claim.matched_sweep_batch_id = batch.id
      LEFT JOIN partner_handoffs handoff ON handoff.sweep_batch_id = batch.id
      LEFT JOIN LATERAL (
        SELECT r.realization_status, r.realized_at
        FROM revenue_realizations r
        WHERE r.ledger_entry_id = e.id
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) realization ON TRUE
      LEFT JOIN LATERAL (
        SELECT d.ramp_reference, d.deposit_state, d.failure_class, d.observed_at
        FROM fiat_deposit_references d
        WHERE d.ledger_entry_id = e.id
        ORDER BY d.observed_at DESC, d.id DESC
        LIMIT 1
      ) deposit ON TRUE
      LEFT JOIN LATERAL (
        SELECT b.bank_reference, b.bank_state, b.failure_code, b.confirmed_at
        FROM bank_payout_confirmations b
        WHERE b.ledger_entry_id = e.id
        ORDER BY b.confirmed_at DESC, b.id DESC
        LIMIT 1
      ) bank ON TRUE
      WHERE e.id = $1`,
    [ledgerEntryId],
  );

  return result.rows[0] ?? null;
}

export async function listLedgerEntryAccountingProjections(filters?: {
  accountingState?: TreasuryAccountingState;
  accountingPeriodId?: number;
  sweepBatchId?: number;
  tradeId?: string;
  limit?: number;
  offset?: number;
}): Promise<ReturnType<typeof projectLedgerEntryAccountingState>[]> {
  const values: Array<number | string> = [];
  const where: string[] = [];

  if (filters?.accountingPeriodId !== undefined) {
    values.push(filters.accountingPeriodId);
    where.push(`period.id = $${values.length}`);
  }

  if (filters?.sweepBatchId !== undefined) {
    values.push(filters.sweepBatchId);
    where.push(`batch.id = $${values.length}`);
  }

  if (filters?.tradeId !== undefined) {
    values.push(filters.tradeId);
    where.push(`e.trade_id = $${values.length}`);
  }

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const baseQuery = `SELECT
        e.id AS ledger_entry_id,
        e.trade_id,
        e.component_type,
        e.amount_raw,
        alloc.entry_amount_raw AS allocated_amount_raw,
        alloc.created_at AS allocated_at,
        e.source_timestamp AS earned_at,
        payout.state AS payout_state,
        period.id AS accounting_period_id,
        period.period_key AS accounting_period_key,
        period.status AS accounting_period_status,
        batch.id AS sweep_batch_id,
        batch.status AS sweep_batch_status,
        alloc.allocation_status,
        claim.tx_hash AS matched_sweep_tx_hash,
        claim.block_number AS matched_sweep_block_number,
        claim.observed_at AS matched_swept_at,
        claim.treasury_identity AS matched_treasury_identity,
        claim.payout_receiver AS matched_payout_receiver,
        claim.amount_raw AS matched_claim_amount_raw,
        handoff.id AS partner_handoff_id,
        handoff.partner_name,
        handoff.partner_reference,
        handoff.handoff_status AS partner_handoff_status,
        handoff.submitted_at AS partner_submitted_at,
        handoff.acknowledged_at AS partner_acknowledged_at,
        handoff.completed_at AS partner_completed_at,
        handoff.failed_at AS partner_failed_at,
        handoff.verified_at AS partner_verified_at,
        deposit.ramp_reference AS latest_fiat_deposit_ramp_reference,
        deposit.deposit_state AS latest_fiat_deposit_state,
        deposit.failure_class AS latest_fiat_deposit_failure_class,
        deposit.observed_at AS latest_fiat_deposit_observed_at,
        bank.bank_reference AS latest_bank_reference,
        bank.bank_state AS latest_bank_payout_state,
        bank.failure_code AS latest_bank_failure_code,
        bank.confirmed_at AS latest_bank_confirmed_at,
        realization.realization_status AS revenue_realization_status,
        realization.realized_at
      FROM treasury_ledger_entries e
      LEFT JOIN LATERAL (
        SELECT p.state
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) payout ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM sweep_batch_entries sbe
        WHERE sbe.ledger_entry_id = e.id
          AND sbe.allocation_status = 'ALLOCATED'
        ORDER BY sbe.updated_at DESC, sbe.id DESC
        LIMIT 1
      ) alloc ON TRUE
      LEFT JOIN sweep_batches batch ON batch.id = alloc.sweep_batch_id
      LEFT JOIN accounting_periods period ON period.id = batch.accounting_period_id
      LEFT JOIN treasury_claim_events claim ON claim.matched_sweep_batch_id = batch.id
      LEFT JOIN partner_handoffs handoff ON handoff.sweep_batch_id = batch.id
      LEFT JOIN LATERAL (
        SELECT r.realization_status, r.realized_at
        FROM revenue_realizations r
        WHERE r.ledger_entry_id = e.id
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) realization ON TRUE
      LEFT JOIN LATERAL (
        SELECT d.ramp_reference, d.deposit_state, d.failure_class, d.observed_at
        FROM fiat_deposit_references d
        WHERE d.ledger_entry_id = e.id
        ORDER BY d.observed_at DESC, d.id DESC
        LIMIT 1
      ) deposit ON TRUE
      LEFT JOIN LATERAL (
        SELECT b.bank_reference, b.bank_state, b.failure_code, b.confirmed_at
        FROM bank_payout_confirmations b
        WHERE b.ledger_entry_id = e.id
        ORDER BY b.confirmed_at DESC, b.id DESC
        LIMIT 1
      ) bank ON TRUE
      ${whereClause}
      ORDER BY e.source_timestamp DESC, e.id DESC`;

  if (!filters?.accountingState) {
    const unfilteredValues = [...values, limit, offset];
    const limitParam = `$${unfilteredValues.length - 1}`;
    const offsetParam = `$${unfilteredValues.length}`;
    const result = await pool.query<LedgerEntryAccountingFacts>(
      `${baseQuery}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      unfilteredValues,
    );
    return result.rows.map((row) => projectLedgerEntryAccountingState(row));
  }

  const projections: ReturnType<typeof projectLedgerEntryAccountingState>[] = [];
  const chunkSize = Math.max(limit * 4, 50);
  let rawOffset = 0;
  let filteredOffset = offset;

  while (projections.length < limit) {
    const chunkValues = [...values, chunkSize, rawOffset];
    const limitParam = `$${chunkValues.length - 1}`;
    const offsetParam = `$${chunkValues.length}`;
    const result = await pool.query<LedgerEntryAccountingFacts>(
      `${baseQuery}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      chunkValues,
    );
    if (result.rows.length === 0) {
      break;
    }

    const matchingProjections = result.rows
      .map((row) => projectLedgerEntryAccountingState(row))
      .filter((projection) => projection.accounting_state === filters.accountingState);

    for (const projection of matchingProjections) {
      if (filteredOffset > 0) {
        filteredOffset -= 1;
        continue;
      }
      projections.push(projection);
      if (projections.length === limit) {
        break;
      }
    }

    rawOffset += result.rows.length;
    if (result.rows.length < chunkSize) {
      break;
    }
  }

  return projections;
}

export async function getLedgerEntryAccountingProjection(
  ledgerEntryId: number,
  queryable: Queryable = pool,
) {
  const facts = await getLedgerEntryAccountingFacts(ledgerEntryId, queryable);
  return facts ? projectLedgerEntryAccountingState(facts) : null;
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

export async function getTreasuryPartnerHandoffByLedgerEntryId(
  ledgerEntryId: number,
): Promise<TreasuryPartnerHandoff | null> {
  const result = await pool.query<TreasuryPartnerHandoff>(
    `SELECT *
     FROM treasury_partner_handoffs
     WHERE ledger_entry_id = $1`,
    [ledgerEntryId],
  );

  return result.rows[0] || null;
}

export async function upsertTreasuryPartnerHandoff(data: TreasuryPartnerHandoffInput): Promise<{
  handoff: TreasuryPartnerHandoff;
  created: boolean;
  idempotentReplay: boolean;
}> {
  const normalized = {
    ledgerEntryId: data.ledgerEntryId,
    partnerCode: data.partnerCode,
    handoffReference: data.handoffReference.trim(),
    partnerStatus: data.partnerStatus,
    payoutReference: data.payoutReference?.trim() || null,
    transferReference: data.transferReference?.trim() || null,
    drainReference: data.drainReference?.trim() || null,
    destinationExternalAccountId: data.destinationExternalAccountId?.trim() || null,
    liquidationAddressId: data.liquidationAddressId?.trim() || null,
    sourceAmount: data.sourceAmount?.trim() || null,
    sourceCurrency: data.sourceCurrency?.trim().toUpperCase() || null,
    destinationAmount: data.destinationAmount?.trim() || null,
    destinationCurrency: data.destinationCurrency?.trim().toUpperCase() || null,
    actor: data.actor.trim(),
    note: data.note?.trim() || null,
    failureCode: data.failureCode?.trim() || null,
    initiatedAt: data.initiatedAt,
    metadata: data.metadata ?? {},
  };
  const payloadHash = createPayloadHash(normalized);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const ledgerEntryResult = await client.query<LedgerEntry>(
      `SELECT * FROM treasury_ledger_entries WHERE id = $1`,
      [normalized.ledgerEntryId],
    );
    if (!ledgerEntryResult.rows[0]) {
      throw new Error('Ledger entry not found');
    }

    const existing = await client.query<TreasuryPartnerHandoff>(
      `SELECT *
       FROM treasury_partner_handoffs
       WHERE ledger_entry_id = $1`,
      [normalized.ledgerEntryId],
    );

    if (existing.rows[0]) {
      if (existing.rows[0].latest_event_payload_hash !== payloadHash) {
        throw new BankPayoutConflictError(
          'Treasury partner handoff already exists with conflicting payload',
        );
      }

      await client.query('COMMIT');
      return {
        handoff: existing.rows[0],
        created: false,
        idempotentReplay: true,
      };
    }

    const result = await client.query<TreasuryPartnerHandoff>(
      `INSERT INTO treasury_partner_handoffs (
          ledger_entry_id,
          partner_code,
          handoff_reference,
          partner_status,
          payout_reference,
          transfer_reference,
          drain_reference,
          destination_external_account_id,
          liquidation_address_id,
          source_amount,
          source_currency,
          destination_amount,
          destination_currency,
          actor,
          note,
          failure_code,
          latest_event_payload_hash,
          metadata,
          initiated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19
        )
        RETURNING *`,
      [
        normalized.ledgerEntryId,
        normalized.partnerCode,
        normalized.handoffReference,
        normalized.partnerStatus,
        normalized.payoutReference,
        normalized.transferReference,
        normalized.drainReference,
        normalized.destinationExternalAccountId,
        normalized.liquidationAddressId,
        normalized.sourceAmount,
        normalized.sourceCurrency,
        normalized.destinationAmount,
        normalized.destinationCurrency,
        normalized.actor,
        normalized.note,
        normalized.failureCode,
        payloadHash,
        JSON.stringify(normalized.metadata),
        normalized.initiatedAt,
      ],
    );

    await client.query('COMMIT');

    return {
      handoff: result.rows[0],
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

export async function appendTreasuryPartnerHandoffEvidence(
  data: TreasuryPartnerHandoffEvidenceInput,
): Promise<{
  handoff: TreasuryPartnerHandoff;
  event: TreasuryPartnerHandoffEvent;
  created: boolean;
  idempotentReplay: boolean;
}> {
  const normalized = {
    ledgerEntryId: data.ledgerEntryId,
    partnerCode: data.partnerCode,
    providerEventId: data.providerEventId.trim(),
    eventType: data.eventType.trim(),
    partnerStatus: data.partnerStatus,
    payoutReference: data.payoutReference?.trim() || null,
    transferReference: data.transferReference?.trim() || null,
    drainReference: data.drainReference?.trim() || null,
    destinationExternalAccountId: data.destinationExternalAccountId?.trim() || null,
    liquidationAddressId: data.liquidationAddressId?.trim() || null,
    bankReference: data.bankReference?.trim() || null,
    bankState: data.bankState ?? null,
    evidenceReference: data.evidenceReference?.trim() || null,
    failureCode: data.failureCode?.trim() || null,
    observedAt: data.observedAt,
    metadata: data.metadata ?? {},
  };
  const payloadHash = createPayloadHash(normalized);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingEvent = await client.query<TreasuryPartnerHandoffEvent>(
      `SELECT *
       FROM treasury_partner_handoff_events
       WHERE provider_event_id = $1`,
      [normalized.providerEventId],
    );

    if (existingEvent.rows[0]) {
      if (existingEvent.rows[0].payload_hash !== payloadHash) {
        throw new BankPayoutConflictError(
          'Duplicate treasury partner evidence event with conflicting payload',
        );
      }

      const existingHandoff = await client.query<TreasuryPartnerHandoff>(
        `SELECT *
         FROM treasury_partner_handoffs
         WHERE id = $1`,
        [existingEvent.rows[0].partner_handoff_id],
      );

      await client.query('COMMIT');
      return {
        handoff: existingHandoff.rows[0],
        event: existingEvent.rows[0],
        created: false,
        idempotentReplay: true,
      };
    }

    const handoffResult = await client.query<TreasuryPartnerHandoff>(
      `SELECT *
       FROM treasury_partner_handoffs
       WHERE ledger_entry_id = $1`,
      [normalized.ledgerEntryId],
    );

    const handoff = handoffResult.rows[0];
    if (!handoff) {
      throw new Error('Treasury partner handoff not found');
    }

    const eventResult = await client.query<TreasuryPartnerHandoffEvent>(
      `INSERT INTO treasury_partner_handoff_events (
          partner_handoff_id,
          ledger_entry_id,
          partner_code,
          provider_event_id,
          event_type,
          partner_status,
          payout_reference,
          transfer_reference,
          drain_reference,
          destination_external_account_id,
          liquidation_address_id,
          bank_reference,
          bank_state,
          evidence_reference,
          failure_code,
          payload_hash,
          metadata,
          observed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18
        )
        RETURNING *`,
      [
        handoff.id,
        normalized.ledgerEntryId,
        normalized.partnerCode,
        normalized.providerEventId,
        normalized.eventType,
        normalized.partnerStatus,
        normalized.payoutReference,
        normalized.transferReference,
        normalized.drainReference,
        normalized.destinationExternalAccountId,
        normalized.liquidationAddressId,
        normalized.bankReference,
        normalized.bankState,
        normalized.evidenceReference,
        normalized.failureCode,
        payloadHash,
        JSON.stringify(normalized.metadata),
        normalized.observedAt,
      ],
    );

    const updatedHandoff = await client.query<TreasuryPartnerHandoff>(
      `UPDATE treasury_partner_handoffs
       SET
         partner_status = $2,
         payout_reference = COALESCE($3, payout_reference),
         transfer_reference = COALESCE($4, transfer_reference),
         drain_reference = COALESCE($5, drain_reference),
         destination_external_account_id = COALESCE($6, destination_external_account_id),
         liquidation_address_id = COALESCE($7, liquidation_address_id),
         failure_code = COALESCE($8, failure_code),
         latest_event_payload_hash = $9,
         metadata = COALESCE(metadata, '{}'::jsonb) || $10::jsonb,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        handoff.id,
        normalized.partnerStatus,
        normalized.payoutReference,
        normalized.transferReference,
        normalized.drainReference,
        normalized.destinationExternalAccountId,
        normalized.liquidationAddressId,
        normalized.failureCode,
        payloadHash,
        JSON.stringify(normalized.metadata),
      ],
    );

    await client.query('COMMIT');

    return {
      handoff: updatedHandoff.rows[0],
      event: eventResult.rows[0],
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
