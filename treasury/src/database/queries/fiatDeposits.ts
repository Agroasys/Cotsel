/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  createFiatDepositPayloadHash,
  deriveFiatDepositFailureClass,
  FiatDepositConflictError,
  normalizeFiatDepositInput,
} from '../../core/fiatDeposit';
import type {
  FiatDepositEvent,
  FiatDepositReference,
  FiatDepositUpsertInput,
  LedgerEntry,
} from '../../types';
import { pool } from '../connection';

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
