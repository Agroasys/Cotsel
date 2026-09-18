/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  assertBatchAllocationAllowed,
  assertSweepBatchRoleSeparation,
  assertSweepBatchTransition,
  sweepBatchActorRole,
} from '../../core/accountingPolicy';
import {
  assertAllocationWithinLedgerAmount,
  assertCanonicalRawAmount,
} from '../../core/canonicalAmount';
import { sumAllocatedEntryAmountRaw } from '../../core/sweepBatchAmounts';
import { assertTransitionApplied, rejectConcurrentWrite } from '../../core/transitionConcurrency';
import type {
  AccountingPeriod,
  AccountingPeriodStatus,
  LedgerEntry,
  PartnerHandoff,
  SweepBatch,
  SweepBatchDetail,
  SweepBatchEntry,
  SweepBatchStatus,
  SweepBatchWithPeriod,
  TreasuryClaimEvent,
} from '../../types';
import { pool } from '../connection';
import { getLedgerEntryAccountingProjection } from './accountingProjections';
import { listTransitionActors, recordTransitionActor } from './transitionActors';

export async function createSweepBatch(data: {
  batchKey: string;
  accountingPeriodId: number;
  assetSymbol: string;
  expectedTotalRaw: string;
  payoutReceiverAddress?: string | null;
  createdBy: string;
  metadata?: Record<string, unknown>;
}): Promise<SweepBatch> {
  assertCanonicalRawAmount(data.expectedTotalRaw, 'expectedTotalRaw');

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

    // The lock makes the checks below decide against the state this transaction
    // will actually write over, instead of a snapshot a racing caller has
    // already moved on from.
    const existingResult = await client.query<SweepBatch>(
      `SELECT *
       FROM sweep_batches
       WHERE id = $1
       FOR UPDATE`,
      [data.batchId],
    );
    const existing = existingResult.rows[0];

    if (!existing) {
      throw new Error('Sweep batch not found');
    }

    const transitionChain = await listTransitionActors(client, 'SWEEP_BATCH', data.batchId);

    assertSweepBatchTransition(existing.status, data.status);
    assertSweepBatchRoleSeparation({
      nextStatus: data.status,
      actor: data.actor,
      createdBy: existing.created_by,
      approvalRequestedBy: existing.approval_requested_by,
      approvedBy: existing.approved_by,
      executedBy: existing.executed_by,
      transitionChain,
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
         AND status = $14
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
        existing.status,
      ],
    );

    // The expected-state predicate is the second half of the guarantee: even if
    // the lock were lost, a row that no longer holds the status this decision
    // was made against is not updated, and the loser is told so.
    assertTransitionApplied(
      result.rowCount,
      `Sweep batch ${data.batchId} changed state concurrently; retry the transition against the current state`,
    );

    const actorRole = sweepBatchActorRole(data.status);
    if (actorRole) {
      await recordTransitionActor(client, {
        subjectType: 'SWEEP_BATCH',
        subjectId: data.batchId,
        fromStatus: existing.status,
        toStatus: data.status,
        actor: data.actor,
        actorRole,
      });
    }

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
       WHERE b.id = $1
       FOR UPDATE OF b`,
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

    // Both rows are read inside this transaction, so the bound is checked
    // against the same ledger amount the allocation is written against.
    const entryAmountRaw = data.entryAmountRaw ?? ledgerEntry.amount_raw;
    assertAllocationWithinLedgerAmount({
      entryAmountRaw,
      ledgerAmountRaw: ledgerEntry.amount_raw,
      ledgerEntryId: data.ledgerEntryId,
    });

    // Two callers can clear the read above at the same time; the partial unique
    // index on active allocations decides the winner, and the loser gets the
    // same answer it would have got from the read.
    const result = await rejectConcurrentWrite(
      async () =>
        client.query<SweepBatchEntry>(
          `INSERT INTO sweep_batch_entries (
          sweep_batch_id,
          ledger_entry_id,
          allocation_status,
          entry_amount_raw,
          allocated_by,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *`,
          [data.sweepBatchId, data.ledgerEntryId, 'ALLOCATED', entryAmountRaw, data.allocatedBy],
        ),
      'Ledger entry is already allocated to an active sweep batch',
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
