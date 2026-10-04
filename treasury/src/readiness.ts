import {
  evaluateReadiness,
  type ReadinessCheck,
  type ReadinessResult,
} from '@agroasys/shared-edge';

export interface TreasuryReadinessDependencies {
  database: () => Promise<void>;
  /** Present when a reconciliation reader is configured; realization is gated on it. */
  reconciliation?: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Treasury dependency readiness. Chain-evidence ingestion freshness is assessed separately by the
 * route, after these dependencies, because its cause detail is part of the probe contract.
 */
export function createTreasuryReadinessCheck(
  dependencies: TreasuryReadinessDependencies,
): () => Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [{ name: 'postgres', check: dependencies.database }];
  if (dependencies.reconciliation) {
    checks.push({ name: 'reconciliation-reader', check: dependencies.reconciliation });
  }

  return () => evaluateReadiness(checks, { defaultTimeoutMs: dependencies.timeoutMs });
}
