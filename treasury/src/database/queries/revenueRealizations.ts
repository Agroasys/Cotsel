import { assertSweepFinalityForProgression } from '../../core/sweepFinalityProgression';
import type { TreasuryFinalizedEvidence } from '../../core/finalizedTransaction';
import {
  assertRealizationAllowed,
  type RealizationReconciliationBinding,
} from '../../core/accountingPolicy';
import { rejectConcurrentWrite } from '../../core/transitionConcurrency';
import type { RevenueRealization, SweepBatch } from '../../types';
import { pool } from '../connection';
import { getLedgerEntryAccountingFacts } from './accountingProjections';
export async function createRevenueRealization(data: {
  finalizedSweepEvidence?: TreasuryFinalizedEvidence;
  ledgerEntryId: number;
  accountingPeriodId: number;
  sweepBatchId?: number | null;
  partnerHandoffId?: number | null;
  actor: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * WP-4 H-25. Resolved by the caller, because the reconciliation run lives in
   * another database, and re-checked here against the entry's own block so a
   * caller cannot assert coverage for a block the entry is not in.
   */
  reconciliationBinding: RealizationReconciliationBinding | null;
}): Promise<RevenueRealization> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const discovered = await getLedgerEntryAccountingFacts(data.ledgerEntryId, client);
    if (!discovered?.sweep_batch_id)
      throw new Error('Original sweep batch is required for realization');
    const locked = await client.query<SweepBatch>(
      'SELECT * FROM sweep_batches WHERE id=$1 FOR UPDATE',
      [discovered.sweep_batch_id],
    );
    if (!locked.rows[0]) throw new Error('Original sweep batch is unavailable');
    assertSweepFinalityForProgression(locked.rows[0], data.finalizedSweepEvidence);

    // Realization is once-per-entry. Locking the batch, then its entry, makes the
    // eligibility read and the insert one decision, so two concurrent
    // realizations cannot both pass `assertRealizationAllowed`.
    await client.query(`SELECT id FROM treasury_ledger_entries WHERE id = $1 FOR UPDATE`, [
      data.ledgerEntryId,
    ]);

    const facts = await getLedgerEntryAccountingFacts(data.ledgerEntryId, client);
    if (!facts || facts.sweep_batch_id !== discovered.sweep_batch_id) {
      throw new Error('Ledger entry accounting facts not found');
    }

    const entryBlock = await client.query<{ block_number: number }>(
      `SELECT block_number FROM treasury_ledger_entries WHERE id = $1`,
      [data.ledgerEntryId],
    );
    const entryBlockNumber = Number(entryBlock.rows[0]?.block_number);
    if (!Number.isFinite(entryBlockNumber)) {
      throw new Error('Ledger entry block number is unavailable');
    }

    // The caller supplies the run it read; the entry's block is re-derived here
    // rather than trusted, so the stored comparison is between the real block
    // and the real watermark.
    const reconciliationBinding = data.reconciliationBinding
      ? { ...data.reconciliationBinding, entryBlockNumber }
      : null;

    assertRealizationAllowed({
      batchStatus: facts.sweep_batch_status,
      partnerHandoffStatus: facts.partner_handoff_status,
      bankPayoutState: facts.latest_bank_payout_state,
      revenueRealizationStatus: facts.revenue_realization_status,
      reconciliationBinding,
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

    assertSweepFinalityForProgression(locked.rows[0], data.finalizedSweepEvidence);

    const result = await rejectConcurrentWrite(
      async () =>
        client.query<RevenueRealization>(
          `INSERT INTO revenue_realizations (
          ledger_entry_id,
          accounting_period_id,
          sweep_batch_id,
          partner_handoff_id,
          realization_status,
          realized_at,
          recognized_by,
          note,
          metadata,
          reconciliation_run_key,
          reconciliation_coverage_to_block,
          entry_block_number
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
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
            JSON.stringify({
              ...data.metadata,
              settlementFinalizedEvidence: data.finalizedSweepEvidence,
            }),
            reconciliationBinding?.runKey ?? null,
            reconciliationBinding?.coverageToBlock ?? null,
            reconciliationBinding ? entryBlockNumber : null,
          ],
        ),
      'Ledger entry was realized concurrently',
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
