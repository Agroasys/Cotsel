import type { Pool, PoolClient } from 'pg';
import { pool } from './connection';
import type { TradeContainmentRow } from '../types';

/** Either the pool or a client bound to an open transaction. */
type Executor = Pool | PoolClient;

/**
 * Open a containment for a trade, or fold a repeat sighting into the standing
 * one.
 *
 * The incident reference and `opened_at` are never overwritten: an operator
 * quoting a reference must keep reaching the same incident. A trade that had
 * reconciled clean and is now diverging again regresses to `CONTAINED`, because
 * the evidence that justified releasing it no longer holds.
 */
export async function openContainment(
  input: {
    tradeId: string;
    incidentReference: string;
    runKey: string;
    qualifyingCodes: string[];
    evidence: Record<string, unknown>;
  },
  executor: Executor = pool,
): Promise<{ row: TradeContainmentRow; opened: boolean }> {
  const result = await executor.query<TradeContainmentRow & { was_opened: boolean }>(
    `INSERT INTO reconcile_trade_containments (
        trade_id, incident_reference, state, opened_run_key,
        qualifying_codes, evidence, observation_count,
        last_observed_run_key, last_observed_at
     ) VALUES ($1, $2, 'CONTAINED', $3, $4::text[], $5::jsonb, 1, $3, NOW())
     ON CONFLICT (trade_id) DO UPDATE SET
        state = 'CONTAINED',
        qualifying_codes = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(
              reconcile_trade_containments.qualifying_codes || EXCLUDED.qualifying_codes
            ) ORDER BY 1
          )
        ),
        evidence = EXCLUDED.evidence,
        observation_count = reconcile_trade_containments.observation_count + 1,
        last_observed_run_key = EXCLUDED.last_observed_run_key,
        last_observed_at = NOW(),
        -- A fresh divergence invalidates any pending clearance.
        cleared_run_key = NULL,
        cleared_at = NULL,
        updated_at = NOW()
     RETURNING *, (xmax = 0) AS was_opened`,
    [
      input.tradeId,
      input.incidentReference,
      input.runKey,
      input.qualifyingCodes,
      JSON.stringify(input.evidence),
    ],
  );

  const row = result.rows[0];
  return { row, opened: row.was_opened };
}

/**
 * Record that a contained trade reconciled clean in a later run.
 *
 * This moves the incident to `RECONCILED_PENDING_APPROVAL` — evidence that the
 * divergence is gone, which is necessary but not sufficient: the trade stays
 * blocked until a governed approval is recorded. The `opened_run_key` guard
 * makes "fresh" literal, so the run that opened an incident can never be the
 * run that clears it.
 */
export async function recordCleanReconciliation(
  input: {
    tradeId: string;
    runKey: string;
  },
  executor: Executor = pool,
): Promise<TradeContainmentRow | null> {
  const result = await executor.query<TradeContainmentRow>(
    `UPDATE reconcile_trade_containments
     SET state = 'RECONCILED_PENDING_APPROVAL',
         cleared_run_key = $2,
         cleared_at = NOW(),
         last_observed_run_key = $2,
         last_observed_at = NOW(),
         updated_at = NOW()
     WHERE trade_id = $1
       AND state = 'CONTAINED'
       AND opened_run_key <> $2
     RETURNING *`,
    [input.tradeId, input.runKey],
  );

  return result.rows[0] ?? null;
}

/**
 * Release a contained trade against a recorded governed approval.
 *
 * Only reachable from `RECONCILED_PENDING_APPROVAL`: approval alone cannot
 * release a trade that is still diverging, and a clean read alone cannot
 * release one that was never approved. Reconciliation never calls this from a
 * comparison result — it is an operator action carrying the quorum decision.
 */
export async function releaseContainment(
  input: {
    tradeId: string;
    approvalReference: string;
  },
  executor: Executor = pool,
): Promise<TradeContainmentRow | null> {
  const result = await executor.query<TradeContainmentRow>(
    `UPDATE reconcile_trade_containments
     SET state = 'RELEASED',
         approval_reference = $2,
         approved_at = NOW(),
         released_at = NOW(),
         updated_at = NOW()
     WHERE trade_id = $1
       AND state = 'RECONCILED_PENDING_APPROVAL'
     RETURNING *`,
    [input.tradeId, input.approvalReference],
  );

  return result.rows[0] ?? null;
}

/**
 * Every trade that must not progress.
 *
 * Both non-released states block: a trade awaiting governed approval is no
 * freer to settle than one still diverging.
 */
export async function listBlockingContainments(
  executor: Executor = pool,
): Promise<TradeContainmentRow[]> {
  const result = await executor.query<TradeContainmentRow>(
    `SELECT * FROM reconcile_trade_containments
     WHERE state <> 'RELEASED'
     ORDER BY opened_at ASC`,
  );

  return result.rows;
}

export async function getContainment(
  tradeId: string,
  executor: Executor = pool,
): Promise<TradeContainmentRow | null> {
  const result = await executor.query<TradeContainmentRow>(
    'SELECT * FROM reconcile_trade_containments WHERE trade_id = $1',
    [tradeId],
  );

  return result.rows[0] ?? null;
}
