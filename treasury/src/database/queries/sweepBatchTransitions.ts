/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sweep batch status transitions, including the WP-4 B-08 execution match,
 * which binds the on-chain claim and moves the batch to EXECUTED in one commit.
 */
import type { PoolClient } from 'pg';
import {
  assertSweepBatchRoleSeparation,
  assertSweepBatchTransition,
  sweepBatchActorRole,
} from '../../core/accountingPolicy';
import { sweepTransitionRequiresCanonicalEntries } from '../../core/sweepCanonicality';
import { assertTransitionApplied } from '../../core/transitionConcurrency';
import type { SweepBatch, SweepBatchStatus } from '../../types';
import { pool } from '../connection';
import { assertSweepBatchEntriesCanonical } from './chainCanonicality';
import { listTransitionActors, recordTransitionActor } from './transitionActors';
import { upsertTreasuryClaimEventWith, type TreasuryClaimEventUpsert } from './treasuryClaims';

interface SweepBatchStatusUpdate {
  batchId: number;
  status: SweepBatchStatus;
  actor: string;
  matchedSweepTxHash?: string | null;
  matchedSweepBlockNumber?: string | null;
  matchedSweptAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function updateSweepBatchStatus(data: SweepBatchStatusUpdate): Promise<SweepBatch> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const batch = await applySweepBatchStatusUpdate(client, data);
    await client.query('COMMIT');
    return batch;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The status update inside a caller's transaction, with the batch row locked. */
async function applySweepBatchStatusUpdate(
  client: PoolClient,
  data: SweepBatchStatusUpdate,
): Promise<SweepBatch> {
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
  // WP-4 B-08 / PRES-05. Decided against the persisted verdict, under lock.
  if (sweepTransitionRequiresCanonicalEntries(data.status)) {
    await assertSweepBatchEntriesCanonical(client, data.batchId);
  }

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

  return result.rows[0];
}

/**
 * WP-4 B-08. The claim match and the EXECUTED transition are one decision. As
 * two commits, a failure between them left the batch APPROVED with a claim
 * already bound to it, and a retry saw the bound claim and reported success
 * without ever executing the batch.
 */
export async function recordSweepBatchExecution(data: {
  claim: TreasuryClaimEventUpsert & { matchedSweepBatchId: number };
  actor: string;
  metadata?: Record<string, unknown>;
}): Promise<SweepBatch> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // The batch is locked before the claim row, the order the status update
    // takes it in, so a concurrent transition waits here instead of deadlocking.
    await client.query(`SELECT id FROM sweep_batches WHERE id = $1 FOR UPDATE`, [
      data.claim.matchedSweepBatchId,
    ]);
    const claimEvent = await upsertTreasuryClaimEventWith(client, data.claim);
    const batch = await applySweepBatchStatusUpdate(client, {
      batchId: data.claim.matchedSweepBatchId,
      status: 'EXECUTED',
      actor: data.actor,
      matchedSweepTxHash: claimEvent.tx_hash,
      matchedSweepBlockNumber: String(claimEvent.block_number),
      matchedSweptAt: claimEvent.observed_at,
      metadata: {
        ...(data.metadata ?? {}),
        matchedTreasuryClaimEventId: claimEvent.source_event_id,
      },
    });

    await client.query('COMMIT');
    return batch;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The emitters of the batch's allocated entries. Every fee the batch sweeps was
 * accrued by the escrow that emitted its ledger event, so that escrow is the
 * only contract whose `TreasuryClaimed` log can prove the sweep.
 */
export async function listSweepBatchEntryLogAddresses(
  batchId: number,
): Promise<Array<string | null>> {
  const result = await pool.query<{ log_address: string | null }>(
    `SELECT DISTINCT LOWER(e.log_address) AS log_address
     FROM sweep_batch_entries sbe
     JOIN treasury_ledger_entries e ON e.id = sbe.ledger_entry_id
     WHERE sbe.sweep_batch_id = $1
       AND sbe.allocation_status = 'ALLOCATED'`,
    [batchId],
  );

  return result.rows.map((row: { log_address: string | null }) => row.log_address);
}
