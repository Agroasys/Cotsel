import { pool } from './connection';
import type { DriftFinding, ReconcileMode, ReconcileRunRow, RunStats } from '../types';

export async function createRun(
  runKey: string,
  mode: ReconcileMode,
): Promise<{ row: ReconcileRunRow; created: boolean }> {
  const insertResult = await pool.query<ReconcileRunRow>(
    `INSERT INTO reconcile_runs (run_key, mode, status)
     VALUES ($1, $2, 'RUNNING')
     ON CONFLICT (run_key) DO NOTHING
     RETURNING *`,
    [runKey, mode],
  );

  if (insertResult.rows[0]) {
    return { row: insertResult.rows[0], created: true };
  }

  const existing = await pool.query<ReconcileRunRow>(
    'SELECT * FROM reconcile_runs WHERE run_key = $1',
    [runKey],
  );

  return { row: existing.rows[0], created: false };
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

export async function completeRun(stats: RunStats): Promise<void> {
  await pool.query(
    `UPDATE reconcile_runs
     SET status = $2,
         completed_at = NOW(),
         total_trades = $3,
         drift_count = $4,
         critical_count = $5,
         high_count = $6,
         medium_count = $7,
         low_count = $8
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
    ],
  );
}

export async function failRun(runKey: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE reconcile_runs
     SET status = 'FAILED',
         completed_at = NOW(),
         error_message = $2
     WHERE run_key = $1`,
    [runKey, errorMessage],
  );
}
