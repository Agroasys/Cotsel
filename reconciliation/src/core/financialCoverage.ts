/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool } from 'pg';

/** Reads retained runs at an anchor now covered by finality; newer drift cannot be bypassed. */
export async function readFinancialCoverage(
  executor: Pick<Pool, 'query'>,
  tradeId: string,
  finalizedBlockNumber: string,
  maxAgeMs: number,
  now = new Date(),
): Promise<{ runKey: string; tradeId: string; verifiedAt: string; evidence: unknown } | null> {
  if (
    !/^(0|[1-9][0-9]{0,77})$/.test(tradeId) ||
    BigInt(tradeId) > (1n << 256n) - 1n ||
    !/^(0|[1-9][0-9]{0,15})$/.test(finalizedBlockNumber) ||
    BigInt(finalizedBlockNumber) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs <= 0
  )
    return null;
  // Completion writers store UTC in the legacy timestamp column. Decode it
  // explicitly so neither the reader session nor Node timezone shifts freshness.
  const result = await executor.query<{
    run_key: string;
    completed_at: Date;
    chain_evidence: unknown;
  }>(
    `SELECT r.run_key, r.completed_at AT TIME ZONE 'UTC' AS completed_at, r.chain_evidence
    FROM reconcile_runs r
    JOIN reconcile_run_trades t ON t.run_id = r.id AND t.run_key = r.run_key
    WHERE t.trade_id = $1 AND r.status = 'COMPLETED' AND r.drift_count = 0 AND r.error_message IS NULL
      AND r.coverage_complete IS TRUE AND r.indexer_enumeration_truncated IS FALSE
      AND r.chain_evidence IS NOT NULL AND r.coverage_to_block <= $2::numeric
      AND r.completed_at AT TIME ZONE 'UTC' >= $3::timestamptz
      AND r.completed_at AT TIME ZONE 'UTC' <= $4::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM reconcile_runs newer JOIN reconcile_run_trades scope ON scope.run_id = newer.id AND scope.run_key = newer.run_key
        WHERE scope.trade_id = $1 AND newer.id > r.id AND
          (newer.status <> 'COMPLETED' OR newer.drift_count <> 0 OR newer.error_message IS NOT NULL
           OR newer.coverage_complete IS DISTINCT FROM TRUE OR newer.indexer_enumeration_truncated IS DISTINCT FROM FALSE
           OR newer.chain_evidence IS NULL)
      )
      AND NOT EXISTS (SELECT 1 FROM reconcile_trade_containments c WHERE c.trade_id = $1 AND c.state <> 'RELEASED')
    ORDER BY r.id DESC LIMIT 1`,
    [tradeId, finalizedBlockNumber, new Date(now.getTime() - maxAgeMs), now],
  );
  const row = result.rows[0];
  if (
    !row ||
    !(row.completed_at instanceof Date) ||
    !Number.isFinite(row.completed_at.getTime()) ||
    now.getTime() < row.completed_at.getTime() ||
    now.getTime() - row.completed_at.getTime() > maxAgeMs
  )
    return null;
  return {
    runKey: row.run_key,
    tradeId,
    verifiedAt: row.completed_at.toISOString(),
    evidence: row.chain_evidence,
  };
}
