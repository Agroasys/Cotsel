/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  assertBankPayoutTransition,
  BankPayoutConflictError,
  createBankPayoutPayloadHash,
  normalizeBankPayoutConfirmationInput,
} from '../../core/bankPayout';
import type {
  BankPayoutConfirmation,
  BankPayoutConfirmationUpsertInput,
  LedgerEntry,
  PayoutLifecycleEvent,
} from '../../types';
import { pool } from '../connection';

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
