import { Logger } from '../utils/logger';

const counters = {
  authFailuresTotal: 0,
  replayRejectsTotal: 0,
};

export function incrementAuthFailure(reason: string): void {
  counters.authFailuresTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'auth_failures_total',
    reason,
    value: counters.authFailuresTotal,
  });
}

export function incrementReplayReject(): void {
  counters.replayRejectsTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'replay_rejects_total',
    value: counters.replayRejectsTotal,
  });
}

/**
 * WP-4 B-09 / FAIL-10. Ingestion emits a signal on every run, including the
 * runs that did nothing. A metric that only appears on success cannot
 * distinguish a healthy quiet period from a worker that stopped emitting.
 */
export function recordIngestionRunOutcome(
  outcome: 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'NOT_OWNER',
  detail: Record<string, unknown>,
): void {
  const metric = {
    metric: 'treasury_ingestion_runs_total',
    outcome,
    ...detail,
  };

  if (outcome === 'FAILED' || outcome === 'BLOCKED') {
    Logger.error('Metric increment', metric);
    return;
  }

  // A capped run is progress, not an incident -- but a run of them means
  // ingestion is not keeping up, which is what the freshness threshold and the
  // lag alarm are there to escalate.
  if (outcome === 'PARTIAL') {
    Logger.warn('Metric increment', metric);
    return;
  }

  Logger.info('Metric increment', metric);
}

/**
 * The lag alarm fires before the freshness threshold does. Staleness blocks
 * export and close, which is a stop; lag is the warning that arrives while an
 * operator can still repair the worker without one.
 */
export function recordIngestionFreshness(sample: {
  status: string;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  lagBlocks: number | null;
  maxLagBlocks: number;
  consecutiveFailureCount: number;
}): void {
  const metric = {
    metric: 'treasury_ingestion_freshness',
    ...sample,
  };

  const lagExceeded = sample.lagBlocks !== null && sample.lagBlocks > sample.maxLagBlocks;
  const ageExceeded = sample.ageSeconds !== null && sample.ageSeconds > sample.maxAgeSeconds;

  if (sample.status !== 'FRESH' || lagExceeded || ageExceeded) {
    Logger.error('Metric increment', metric);
    return;
  }

  if (sample.consecutiveFailureCount > 0) {
    Logger.warn('Metric increment', metric);
    return;
  }

  Logger.info('Metric increment', metric);
}
