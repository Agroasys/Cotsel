import type { Pool, PoolClient } from 'pg';
import { pool } from './connection';
import type {
  AbandonedRunRecord,
  LeaseEvent,
  ReconcileMode,
  ReconcileRunRow,
  RunClaim,
  RunLeaseIdentity,
} from '../types';

/** Either the pool or a client bound to an open transaction. */
type Executor = Pool | PoolClient;

/**
 * Thrown when a run discovers the lease it was working under is no longer its
 * own. The run must publish nothing: a successor may already be writing the
 * same window, and two workers publishing one run key would interleave their
 * findings into a single, unattributable result.
 */
export class LeaseLostError extends Error {
  constructor(readonly lease: RunLeaseIdentity) {
    super(
      `Reconciliation lease lost for run ${lease.runKey} (owner ${lease.owner}, epoch ${lease.epoch})`,
    );
    this.name = 'LeaseLostError';
  }
}

/**
 * A RUNNING row is past its lease when the lease says so, or — for a row
 * written before this control existed, which has no lease at all — when a full
 * TTL has passed since it started. Without the fallback a pre-lease row would
 * stay RUNNING forever, which is the wedge this control exists to remove.
 */
function expiryPredicate(ttlParam: number): string {
  return `COALESCE(lease_expires_at, started_at + make_interval(secs => $${ttlParam}::double precision / 1000)) <= NOW()`;
}

export async function appendLeaseEvent(
  input: {
    runId: number;
    runKey: string;
    event: LeaseEvent;
    owner: string | null;
    epoch: number;
    previousOwner?: string | null;
    detail?: Record<string, unknown>;
  },
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `INSERT INTO reconcile_run_lease_events (
        run_id, run_key, event, lease_owner, lease_epoch, previous_owner, detail
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.runId,
      input.runKey,
      input.event,
      input.owner,
      input.epoch,
      input.previousOwner ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

/**
 * Take ownership of a run key, or report why it could not be taken.
 *
 * A fresh key is inserted already leased. An existing key is claimable only
 * when it is not COMPLETED and no live lease covers it; the conditional UPDATE
 * is what makes "one safe successor" true — two workers racing it both lock the
 * same row, and the loser re-evaluates the predicate against the winner's
 * committed lease and matches nothing.
 */
export async function claimRun(
  input: {
    runKey: string;
    mode: ReconcileMode;
    owner: string;
    leaseTtlMs: number;
  },
  executor: Executor = pool,
): Promise<RunClaim> {
  const inserted = await executor.query<ReconcileRunRow>(
    `INSERT INTO reconcile_runs (
        run_key, mode, status, lease_owner, lease_epoch,
        lease_acquired_at, lease_heartbeat_at, lease_expires_at
     ) VALUES (
        $1, $3, 'RUNNING', $4, 1,
        NOW(), NOW(), NOW() + make_interval(secs => $2::double precision / 1000)
     )
     ON CONFLICT (run_key) DO NOTHING
     RETURNING *`,
    [input.runKey, input.leaseTtlMs, input.mode, input.owner],
  );

  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    await appendLeaseEvent(
      {
        runId: insertedRow.id,
        runKey: input.runKey,
        event: 'ACQUIRED',
        owner: input.owner,
        epoch: insertedRow.lease_epoch,
        detail: { mode: input.mode, leaseTtlMs: input.leaseTtlMs },
      },
      executor,
    );

    return {
      claimed: true,
      run: {
        row: insertedRow,
        lease: { runKey: input.runKey, owner: input.owner, epoch: insertedRow.lease_epoch },
        takeoverFrom: null,
      },
    };
  }

  // A SET expression reads the pre-update row, so `abandoned_owner` captures
  // whoever held the lease before this takeover. RETURNING then reports the
  // displaced owner — reading `lease_owner` back would return the new one.
  const takeover = await executor.query<ReconcileRunRow>(
    `UPDATE reconcile_runs
     SET status = 'RUNNING',
         lease_owner = $3,
         lease_epoch = lease_epoch + 1,
         lease_acquired_at = NOW(),
         lease_heartbeat_at = NOW(),
         lease_expires_at = NOW() + make_interval(secs => $2::double precision / 1000),
         takeover_count = takeover_count + 1,
         abandoned_owner = COALESCE(lease_owner, abandoned_owner),
         abandoned_at = CASE WHEN status = 'RUNNING' THEN NOW() ELSE abandoned_at END,
         completed_at = NULL,
         error_message = NULL
     WHERE run_key = $1
       AND status <> 'COMPLETED'
       AND (status <> 'RUNNING' OR ${expiryPredicate(2)})
     RETURNING *`,
    [input.runKey, input.leaseTtlMs, input.owner],
  );

  const takenRow = takeover.rows[0];
  if (takenRow) {
    await appendLeaseEvent(
      {
        runId: takenRow.id,
        runKey: input.runKey,
        event: 'RECLAIMED',
        owner: input.owner,
        epoch: takenRow.lease_epoch,
        previousOwner: takenRow.abandoned_owner,
        detail: {
          mode: input.mode,
          leaseTtlMs: input.leaseTtlMs,
          takeoverCount: takenRow.takeover_count,
        },
      },
      executor,
    );

    return {
      claimed: true,
      run: {
        row: takenRow,
        lease: { runKey: input.runKey, owner: input.owner, epoch: takenRow.lease_epoch },
        takeoverFrom: takenRow.abandoned_owner,
      },
    };
  }

  const existing = await executor.query<ReconcileRunRow>(
    'SELECT * FROM reconcile_runs WHERE run_key = $1',
    [input.runKey],
  );

  const row = existing.rows[0];
  return {
    claimed: false,
    refusal: row.status === 'COMPLETED' ? 'ALREADY_COMPLETED' : 'LEASE_HELD',
    row,
  };
}

/**
 * Push the lease expiry out while the run is still working.
 *
 * Returns false when the row no longer matches this owner and epoch, which is
 * the run's signal that it was declared abandoned and must stop.
 */
export async function heartbeatLease(
  lease: RunLeaseIdentity,
  leaseTtlMs: number,
  executor: Executor = pool,
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE reconcile_runs
     SET lease_heartbeat_at = NOW(),
         lease_expires_at = NOW() + make_interval(secs => $4::double precision / 1000)
     WHERE run_key = $1
       AND lease_owner = $2
       AND lease_epoch = $3
       AND status = 'RUNNING'`,
    [lease.runKey, lease.owner, lease.epoch, leaseTtlMs],
  );

  return result.rowCount === 1;
}

/**
 * Lock the run row and prove this lease still owns it.
 *
 * Called inside the finalizing transaction: `FOR UPDATE` holds off a concurrent
 * takeover until the transaction settles, so the run either publishes under a
 * lease it demonstrably still held or publishes nothing.
 */
export async function assertLeaseHeld(client: PoolClient, lease: RunLeaseIdentity): Promise<void> {
  const held = await client.query(
    `SELECT 1 FROM reconcile_runs
     WHERE run_key = $1 AND lease_owner = $2 AND lease_epoch = $3
     FOR UPDATE`,
    [lease.runKey, lease.owner, lease.epoch],
  );

  if (held.rowCount !== 1) {
    throw new LeaseLostError(lease);
  }
}

/**
 * Drop the lease once the run has reached a terminal status.
 *
 * Refuses to un-lease a row that is still RUNNING. Such a row would look
 * unowned but still be worked on, and after the grace window a second worker
 * could claim it and run the same window concurrently — the exact collision the
 * lease exists to prevent. Callers release only after a terminal status is
 * committed, and this guard keeps that a property of the schema rather than of
 * every call site.
 */
export async function releaseLease(
  lease: RunLeaseIdentity,
  executor: Executor = pool,
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE reconcile_runs
     SET lease_owner = NULL,
         lease_expires_at = NULL
     WHERE run_key = $1
       AND lease_owner = $2
       AND lease_epoch = $3
       AND status <> 'RUNNING'`,
    [lease.runKey, lease.owner, lease.epoch],
  );

  return result.rowCount === 1;
}

/**
 * Mark every RUNNING run whose lease has expired as abandoned.
 *
 * This is the detection half of the control and runs independently of any
 * successor: a crashed run is marked and alerted even when nothing ever comes
 * back to claim its key, so a wedged run cannot sit invisible behind a status
 * that still reads RUNNING.
 *
 * `lease_expires_at` is deliberately left in place. The row is no longer
 * RUNNING so the expiry predicate can never see it again, and the timestamp is
 * the evidence of when the lease actually lapsed.
 */
export async function markAbandonedRuns(
  leaseTtlMs: number,
  executor: Executor = pool,
): Promise<AbandonedRunRecord[]> {
  const result = await executor.query<{
    id: number;
    run_key: string;
    mode: ReconcileMode;
    started_at: Date;
    abandoned_owner: string | null;
    lease_epoch: number;
    lease_expires_at: Date | null;
    lease_heartbeat_at: Date | null;
    takeover_count: number;
  }>(
    `UPDATE reconcile_runs
     SET status = 'ABANDONED',
         abandoned_at = NOW(),
         abandoned_owner = lease_owner,
         lease_owner = NULL
     WHERE status = 'RUNNING'
       AND ${expiryPredicate(1)}
     RETURNING id, run_key, mode, started_at, abandoned_owner, lease_epoch,
               lease_expires_at, lease_heartbeat_at, takeover_count`,
    [leaseTtlMs],
  );

  const abandoned: AbandonedRunRecord[] = [];
  for (const row of result.rows) {
    await appendLeaseEvent(
      {
        runId: row.id,
        runKey: row.run_key,
        event: 'ABANDONED',
        owner: null,
        epoch: row.lease_epoch,
        previousOwner: row.abandoned_owner,
        detail: {
          leaseTtlMs,
          lastHeartbeatAt: row.lease_heartbeat_at?.toISOString() ?? null,
          startedAt: row.started_at.toISOString(),
        },
      },
      executor,
    );

    abandoned.push({
      runKey: row.run_key,
      mode: row.mode,
      owner: row.abandoned_owner,
      epoch: row.lease_epoch,
      startedAt: row.started_at,
      leaseExpiresAt: row.lease_expires_at,
      lastHeartbeatAt: row.lease_heartbeat_at,
      takeoverCount: row.takeover_count,
    });
  }

  return abandoned;
}
