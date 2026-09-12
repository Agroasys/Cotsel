import type { Pool, PoolClient } from 'pg';
import { pool } from './connection';
import { assertLeaseHeld, releaseLease } from './leases';
import type { DriftFinding, RunLeaseIdentity, RunStats } from '../types';

/** Either the pool or a client bound to an open transaction. */
type Executor = Pool | PoolClient;

export const COVERAGE_CURSOR_SCOPE = 'trades';

export interface CoverageCursor {
  lastTradeId: bigint;
  boundaryBlockNumber: number;
  boundaryBlockHash: string;
  tailFirstSeenAt: Date | null;
}

/** A missing row means the sweep has never run: start from id 0. */
export async function readCoverageCursor(
  scope: string = COVERAGE_CURSOR_SCOPE,
): Promise<CoverageCursor> {
  const result = await pool.query<{
    last_trade_id: string;
    boundary_block_number: string;
    boundary_block_hash: string;
    tail_first_seen_at: Date | null;
  }>(
    `SELECT last_trade_id::text, boundary_block_number::text, boundary_block_hash, tail_first_seen_at
     FROM reconcile_cursors
     WHERE scope = $1`,
    [scope],
  );

  const row = result.rows[0];
  if (!row) {
    return {
      lastTradeId: 0n,
      boundaryBlockNumber: 0,
      boundaryBlockHash: '',
      tailFirstSeenAt: null,
    };
  }

  return {
    lastTradeId: BigInt(row.last_trade_id),
    boundaryBlockNumber: Number(row.boundary_block_number),
    boundaryBlockHash: row.boundary_block_hash,
    tailFirstSeenAt: row.tail_first_seen_at,
  };
}

/**
 * Advance the cursor past a window that fully reconciled.
 *
 * The cursor must never move past a range with an unresolved coverage gap:
 * doing so would retire the evidence of a chain trade the indexer never
 * projected and let the next run report clean.
 */
export async function advanceCoverageCursor(
  input: {
    scope?: string;
    lastTradeId: bigint;
    boundaryBlockNumber: number;
    boundaryBlockHash: string;
    tailFirstSeenAt: Date | null;
  },
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `INSERT INTO reconcile_cursors (
        scope, last_trade_id, boundary_block_number, boundary_block_hash, tail_first_seen_at, updated_at
     ) VALUES ($1, $2::numeric, $3, $4, $5, NOW())
     ON CONFLICT (scope) DO UPDATE SET
        last_trade_id = EXCLUDED.last_trade_id,
        boundary_block_number = EXCLUDED.boundary_block_number,
        boundary_block_hash = EXCLUDED.boundary_block_hash,
        tail_first_seen_at = EXCLUDED.tail_first_seen_at,
        updated_at = NOW()`,
    [
      input.scope ?? COVERAGE_CURSOR_SCOPE,
      input.lastTradeId.toString(),
      input.boundaryBlockNumber,
      input.boundaryBlockHash,
      input.tailFirstSeenAt,
    ],
  );
}

/** Record when a non-empty tail was first observed, without moving the cursor. */
export async function recordCoverageTailSighting(
  input: {
    scope?: string;
    tailFirstSeenAt: Date | null;
  },
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `INSERT INTO reconcile_cursors (scope, tail_first_seen_at, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (scope) DO UPDATE SET
        tail_first_seen_at = EXCLUDED.tail_first_seen_at,
        updated_at = NOW()`,
    [input.scope ?? COVERAGE_CURSOR_SCOPE, input.tailFirstSeenAt],
  );
}

export async function upsertDrift(
  runId: number,
  runKey: string,
  finding: DriftFinding,
): Promise<void> {
  await pool.query(
    `INSERT INTO reconcile_drifts (
        run_id,
        run_key,
        trade_id,
        severity,
        mismatch_code,
        compared_field,
        onchain_value,
        indexed_value,
        details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (run_key, trade_id, mismatch_code, compared_field)
     DO UPDATE SET
        run_id = EXCLUDED.run_id,
        severity = EXCLUDED.severity,
        onchain_value = EXCLUDED.onchain_value,
        indexed_value = EXCLUDED.indexed_value,
        details = EXCLUDED.details,
        occurrences = reconcile_drifts.occurrences + 1,
        updated_at = NOW()`,
    [
      runId,
      runKey,
      finding.tradeId,
      finding.severity,
      finding.mismatchCode,
      finding.comparedField,
      finding.onchainValue,
      finding.indexedValue,
      JSON.stringify(finding.details),
    ],
  );
}

export async function upsertRunTradeScope(
  runId: number,
  runKey: string,
  tradeId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO reconcile_run_trades (run_id, run_key, trade_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_key, trade_id) DO NOTHING`,
    [runId, runKey, tradeId],
  );
}

/**
 * A completed run publishes its covered trade-id range, block interval, next
 * cursor and uncovered tail, so a reader can tell a complete sweep from a
 * truncated one without inspecting the code.
 */
export async function completeRun(stats: RunStats, executor: Executor = pool): Promise<void> {
  const coverage = stats.coverage;
  await executor.query(
    `UPDATE reconcile_runs
     SET status = $2,
         completed_at = NOW(),
         total_trades = $3,
         drift_count = $4,
         critical_count = $5,
         high_count = $6,
         medium_count = $7,
         low_count = $8,
         coverage_from_trade_id = $9::numeric,
         coverage_to_trade_id = $10::numeric,
         coverage_from_block = $11,
         coverage_to_block = $12,
         chain_trade_counter = $13::numeric,
         next_cursor = $14::numeric,
         uncovered_tail = $15::numeric,
         coverage_complete = $16,
         indexer_enumeration_truncated = $17,
         indexer_enumeration_walked = $18
     WHERE run_key = $1`,
    [
      stats.runKey,
      stats.status,
      stats.totalTrades,
      stats.driftCount,
      stats.severityCounts.CRITICAL,
      stats.severityCounts.HIGH,
      stats.severityCounts.MEDIUM,
      stats.severityCounts.LOW,
      coverage ? coverage.window.fromTradeId.toString() : null,
      coverage ? coverage.window.toTradeId.toString() : null,
      coverage ? coverage.fromBlock : null,
      coverage ? coverage.boundary.blockNumber : null,
      coverage ? coverage.boundary.chainTradeCounter.toString() : null,
      coverage ? coverage.nextCursor.toString() : null,
      coverage ? coverage.window.uncoveredTail.toString() : null,
      coverage ? coverage.complete : null,
      coverage ? coverage.indexerEnumerationTruncated : null,
      coverage ? coverage.indexerEnumerationWalked : null,
    ],
  );
}

/**
 * Publish the run's complete-range accounting and move (or hold) the cursor in
 * a single transaction.
 *
 * These two writes must commit together: if the cursor advanced in its own
 * transaction and the run row then failed to complete, the next run would
 * resume past a window whose evidence was never recorded — a range silently
 * skipped behind a run marked failed. One transaction makes the cursor move
 * exactly when, and only when, its run is recorded as complete.
 */
export async function finalizeRun(
  input: {
    stats: RunStats;
    /**
     * The lease this run has been working under. Checked under `FOR UPDATE` as
     * the first statement of the transaction, so a run that was declared
     * abandoned — and whose window a successor may already have redone — cannot
     * publish its findings or move the cursor on top of that successor.
     */
    lease: RunLeaseIdentity;
    cursor:
      | {
          advance: true;
          lastTradeId: bigint;
          boundaryBlockNumber: number;
          boundaryBlockHash: string;
          tailFirstSeenAt: Date | null;
        }
      | { advance: false; tailFirstSeenAt: Date | null };
  },
  db: Pool = pool,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertLeaseHeld(client, input.lease);
    await completeRun(input.stats, client);
    // The run is terminal, so the key is free immediately rather than after a
    // TTL. This rides the same transaction: a rolled-back run keeps its lease.
    await releaseLease(input.lease, client);

    if (input.cursor.advance) {
      await advanceCoverageCursor(
        {
          lastTradeId: input.cursor.lastTradeId,
          boundaryBlockNumber: input.cursor.boundaryBlockNumber,
          boundaryBlockHash: input.cursor.boundaryBlockHash,
          tailFirstSeenAt: input.cursor.tailFirstSeenAt,
        },
        client,
      );
    } else {
      await recordCoverageTailSighting({ tailFirstSeenAt: input.cursor.tailFirstSeenAt }, client);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Record a run that threw.
 *
 * Fenced on the lease for the same reason `finalizeRun` is: a displaced worker
 * failing late must not stamp FAILED over a successor that is mid-run, or over
 * a run the successor already completed.
 */
export async function failRun(
  lease: RunLeaseIdentity,
  errorMessage: string,
  executor: Executor = pool,
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE reconcile_runs
     SET status = 'FAILED',
         completed_at = NOW(),
         error_message = $4,
         lease_owner = NULL,
         lease_expires_at = NULL
     WHERE run_key = $1
       AND lease_owner = $2
       AND lease_epoch = $3`,
    [lease.runKey, lease.owner, lease.epoch, errorMessage],
  );

  return result.rowCount === 1;
}
