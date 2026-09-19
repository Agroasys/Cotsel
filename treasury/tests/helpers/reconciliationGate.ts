/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * A reconciliation run that is fresh, in scope, drift free, and reached far
 * enough to cover the fixture entry. Suites about something *other* than
 * reconciliation use it so their cases do not block for a reason they are not
 * testing; suites about the watermark build their own gate instead.
 */
import type { TradeReconciliationGate } from '../../src/core/reconciliationGate';

export function clearReconciliationGate(
  overrides: Partial<TradeReconciliationGate> = {},
): TradeReconciliationGate {
  return {
    tradeId: 'trade-1',
    status: 'CLEAR',
    runKey: 'run-1',
    driftCount: 0,
    freshness: 'FRESH',
    completedAt: new Date('2026-03-31T00:05:00.000Z'),
    staleRunningRunCount: 0,
    coverageFromBlock: 0,
    coverageToBlock: 1_000_000,
    coverageComplete: true,
    blockedReasons: [],
    ...overrides,
  };
}

export const clearReconciliation = {
  assessTrades: async () => new Map([['trade-1', clearReconciliationGate()]]),
};
