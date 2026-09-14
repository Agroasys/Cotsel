import type { Pool, PoolClient } from 'pg';
import { pool } from './connection';
import type { PendingRunAlertRow, RunAlertPayload } from '../types';

/** Either the pool or a client bound to an open transaction. */
type Executor = Pool | PoolClient;

/**
 * Queue an alert as part of the transaction that produces its evidence.
 *
 * Alerting straight from the comparison loop tells an operator about findings
 * the run may still be fenced out of publishing: a worker displaced after its
 * last batch would have paged on drift that never lands, and named a trade it
 * never actually contained. Enqueued here, the alert rolls back with everything
 * else the rejected run tried to write.
 */
export async function enqueueRunAlert(
  input: { runId: number; runKey: string; alert: RunAlertPayload },
  executor: Executor,
): Promise<void> {
  await executor.query(
    `INSERT INTO reconcile_alert_outbox (run_id, run_key, kind, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [input.runId, input.runKey, input.alert.kind, JSON.stringify(input.alert.payload)],
  );
}

/**
 * Read the alerts that are committed but not yet delivered.
 *
 * Deliberately not scoped to the current run: an outbox row left behind by a
 * worker that died between COMMIT and dispatch is still owed to an operator,
 * and the next run to reach this point is the one that owes it.
 */
export async function readPendingRunAlerts(
  limit: number,
  executor: Executor = pool,
): Promise<PendingRunAlertRow[]> {
  const result = await executor.query<PendingRunAlertRow>(
    `SELECT id::text, run_key, kind, payload, dispatch_attempts
     FROM reconcile_alert_outbox
     WHERE dispatched_at IS NULL
     ORDER BY id
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}

export async function markRunAlertDispatched(id: string, executor: Executor = pool): Promise<void> {
  await executor.query(
    `UPDATE reconcile_alert_outbox
     SET dispatched_at = NOW(), dispatch_attempts = dispatch_attempts + 1, last_error = NULL
     WHERE id = $1::bigint AND dispatched_at IS NULL`,
    [id],
  );
}

/**
 * Record a delivery that failed, leaving the row pending.
 *
 * A webhook that is down must not consume the alert. The attempt count and the
 * last error are what let an operator tell "nothing to say" from "could not say
 * it", which a silently dropped alert would hide.
 */
export async function recordRunAlertFailure(
  id: string,
  error: string,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `UPDATE reconcile_alert_outbox
     SET dispatch_attempts = dispatch_attempts + 1, last_error = $2
     WHERE id = $1::bigint AND dispatched_at IS NULL`,
    [id, error],
  );
}
