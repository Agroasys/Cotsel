import type { Pool, PoolClient } from 'pg';
import { pool } from './connection';
import type { GovernedUnpauseEvidence, TradeContainmentRow, TradePauseObservation } from '../types';

/** Postgres unique-violation, raised when an approval receipt is replayed. */
const UNIQUE_VIOLATION = '23505';

export class ReplayedApprovalError extends Error {
  constructor(readonly txHash: string) {
    super(
      `Governed unpause ${txHash} has already released a containment; a release needs its own approval transaction`,
    );
    this.name = 'ReplayedApprovalError';
  }
}

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
        -- It also invalidates the recovery evidence of the previous incident.
        -- A governed unpause lifted the pause it was granted for; this trade is
        -- diverging again, so it is neither paused nor approved any more, and
        -- the receipt that released it cannot release it a second time.
        pause_observed_at = NULL,
        pause_observed_block = NULL,
        approval_tx_hash = NULL,
        approval_chain_id = NULL,
        approval_contract = NULL,
        approval_block_number = NULL,
        approval_block_hash = NULL,
        approval_log_index = NULL,
        approval_incident_ref = NULL,
        approval_approvers = ARRAY[]::TEXT[],
        approval_count = NULL,
        approval_required = NULL,
        approved_at = NULL,
        released_at = NULL,
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
 * Record what the chain says about the escrow's scoped pause for this trade.
 *
 * `pause_last_checked_at` moves on every read so an operator can tell a pause
 * that was never checked from one that was checked and found missing. The
 * observation itself is only written when the trade was actually read as
 * paused: a failed read, or a read that came back unpaused, must not look like
 * evidence that the on-chain half of the containment is in place.
 */
export async function recordPauseObservation(
  observation: TradePauseObservation,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `UPDATE reconcile_trade_containments
     SET pause_last_checked_at = NOW(),
         pause_observed_at = CASE WHEN $2 THEN NOW() ELSE pause_observed_at END,
         pause_observed_block = CASE WHEN $2 THEN $3::bigint ELSE pause_observed_block END,
         updated_at = NOW()
     WHERE trade_id = $1
       AND state <> 'RELEASED'`,
    [observation.tradeId, observation.paused, observation.blockNumber],
  );
}

/**
 * Release a contained trade against the governed on-chain unpause that
 * authorised it.
 *
 * Only reachable from `RECONCILED_PENDING_APPROVAL`: approval alone cannot
 * release a trade that is still diverging, and a clean read alone cannot
 * release one that was never approved. The evidence is read back from the
 * chain, not asserted by the caller, and the row it lands on must itself have
 * been seen paused — otherwise this would be recording a recovery from a
 * containment the escrow never enforced.
 *
 * Spending the receipt and releasing the trade are one statement. The insert
 * into the spent ledger is what makes a receipt single-use, and it is driven by
 * the same predicate as the update, so a release that is not permitted spends
 * nothing and a receipt that is already spent releases nothing.
 *
 * Reconciliation never calls this from a comparison result.
 */
export async function releaseContainment(
  input: {
    tradeId: string;
    evidence: GovernedUnpauseEvidence;
  },
  executor: Executor = pool,
): Promise<TradeContainmentRow | null> {
  const { evidence } = input;

  try {
    const result = await executor.query<TradeContainmentRow>(
      `WITH releasable AS (
         SELECT trade_id, incident_reference
         FROM reconcile_trade_containments
         WHERE trade_id = $1
           AND state = 'RECONCILED_PENDING_APPROVAL'
           AND pause_observed_at IS NOT NULL
       ), spent AS (
         INSERT INTO reconcile_spent_unpause_approvals (
            tx_hash, trade_id, incident_reference, chain_id, block_number, log_index
         )
         SELECT $2, trade_id, incident_reference, $3::bigint, $5::bigint, $7
         FROM releasable
         RETURNING trade_id
       )
       UPDATE reconcile_trade_containments
       SET state = 'RELEASED',
           approval_tx_hash = $2,
           approval_chain_id = $3::bigint,
           approval_contract = $4,
           approval_block_number = $5::bigint,
           approval_block_hash = $6,
           approval_log_index = $7,
           approval_incident_ref = $8,
           approval_approvers = $9::text[],
           approval_count = $10,
           approval_required = $11,
           approved_at = $12,
           released_at = NOW(),
           updated_at = NOW()
       WHERE trade_id = (SELECT trade_id FROM spent)
       RETURNING *`,
      [
        input.tradeId,
        evidence.txHash,
        evidence.chainId,
        evidence.contractAddress,
        evidence.blockNumber,
        evidence.blockHash,
        evidence.logIndex,
        evidence.incidentRef,
        evidence.approvers,
        evidence.approvalCount,
        evidence.requiredApprovals,
        evidence.executedAt,
      ],
    );

    return result.rows[0] ?? null;
  } catch (error: unknown) {
    // The spent-approvals ledger is the replay guard: one governed unpause
    // releases one containment, and re-presenting it for another trade, or for
    // a reopened incident on the same trade, lands here.
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ReplayedApprovalError(evidence.txHash);
      }
    }
    throw error;
  }
}

/**
 * Every trade the oracle must not progress.
 *
 * The blocking set is the containment control's enforcement surface: a trade
 * named here is refused by the oracle before any progression is submitted,
 * whether or not the on-chain scoped pause has landed yet.
 */
export async function isTradeContained(
  tradeId: string,
  executor: Executor = pool,
): Promise<TradeContainmentRow | null> {
  const result = await executor.query<TradeContainmentRow>(
    `SELECT * FROM reconcile_trade_containments
     WHERE trade_id = $1 AND state <> 'RELEASED'`,
    [tradeId],
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
