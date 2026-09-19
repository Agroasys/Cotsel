/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Eligibility now asks whether treasury's chain evidence is current before it
 * judges any entry, so every eligibility suite needs an answer to that
 * question. These are the two answers worth stubbing: current, and stopped.
 */
import type { IngestionFreshnessAssessment } from '../../src/core/ingestionFreshness';

export function freshIngestionAssessment(
  overrides?: Partial<IngestionFreshnessAssessment>,
): IngestionFreshnessAssessment {
  return {
    status: 'FRESH',
    lastSuccessAt: new Date('2026-03-31T00:10:00.000Z'),
    ageSeconds: 30,
    maxAgeSeconds: 900,
    lagBlocks: 0,
    maxLagBlocks: 300,
    ingestedThroughBlockNumber: 110,
    stableBlockNumber: 110,
    consecutiveFailureCount: 0,
    lastBlockedReason: null,
    blockedReasons: [],
    ...overrides,
  };
}

export function staleIngestionAssessment(
  blockedReasons: string[] = [
    'Treasury ingestion last completed 3600s ago, beyond the 900s freshness threshold.',
  ],
): IngestionFreshnessAssessment {
  return freshIngestionAssessment({
    status: 'STALE',
    ageSeconds: 3600,
    blockedReasons,
  });
}

export function freshIngestion(): {
  assess: (options?: {
    stableBlockNumber?: number | null;
  }) => Promise<IngestionFreshnessAssessment>;
} {
  return { assess: async () => freshIngestionAssessment() };
}

export function staleIngestion(blockedReasons?: string[]): {
  assess: (options?: {
    stableBlockNumber?: number | null;
  }) => Promise<IngestionFreshnessAssessment>;
} {
  return { assess: async () => staleIngestionAssessment(blockedReasons) };
}
