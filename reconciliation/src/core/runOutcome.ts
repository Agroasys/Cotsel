import { finalizeRun } from '../database/queries';
import { Logger } from '../utils/logger';
import type { DriftSeverity, ReconcileMode, RunStats } from '../types';

export const DEFAULT_SEVERITY_COUNTS: Record<DriftSeverity, number> = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
};

/** A run key that was already taken: report the recorded row, change nothing. */
export function skippedStats(
  runKey: string,
  mode: ReconcileMode,
  row: {
    total_trades: number;
    drift_count: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
  },
  skippedReason: string,
): RunStats {
  return {
    runKey,
    mode,
    status: 'SKIPPED',
    totalTrades: row.total_trades,
    driftCount: row.drift_count,
    severityCounts: {
      CRITICAL: row.critical_count,
      HIGH: row.high_count,
      MEDIUM: row.medium_count,
      LOW: row.low_count,
    },
    skippedReason,
  };
}

/**
 * Record a run that could not conclude.
 *
 * Both inconclusive exits — no indexer checkpoint to anchor the chain reads to,
 * and an indexer that moved while the run was reading it — leave the same state
 * behind: no drift published, the cursor held where it was, and the tail clock
 * carried through untouched, because a run that could not compare anything is
 * no evidence that a backlog drained.
 */
export async function finalizeInconclusiveRun(input: {
  stats: RunStats;
  reason: string;
  tailFirstSeenAt: Date | null;
  context: Record<string, unknown>;
}): Promise<RunStats> {
  const inconclusive: RunStats = {
    ...input.stats,
    status: 'SKIPPED',
    totalTrades: 0,
    driftCount: 0,
    severityCounts: { ...DEFAULT_SEVERITY_COUNTS },
    skippedReason: input.reason,
  };

  Logger.error('Reconciliation run inconclusive; publishing no drift and holding the cursor', {
    runKey: inconclusive.runKey,
    mode: inconclusive.mode,
    reason: input.reason,
    ...input.context,
  });

  await finalizeRun({
    stats: inconclusive,
    cursor: { advance: false, tailFirstSeenAt: input.tailFirstSeenAt },
  });

  return inconclusive;
}
