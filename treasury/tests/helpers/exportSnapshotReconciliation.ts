import type {
  ReconciliationRunAnchor,
  TradeReconciliationGate,
} from '../../src/core/reconciliationGate';

export function snapshotReconciliationFixture(): {
  snapshotRunAnchor(): Promise<ReconciliationRunAnchor>;
  assessTrades(ids: string[]): Promise<Map<string, TradeReconciliationGate>>;
} {
  const anchor: ReconciliationRunAnchor = {
    runKey: 'run-1',
    completedAt: new Date('2026-03-31T00:05:00Z'),
    coverageFromBlock: 0,
    coverageToBlock: 110,
    coverageComplete: true,
    staleRunningRunCount: 0,
  };
  return {
    snapshotRunAnchor: async () => anchor,
    assessTrades: async (ids) =>
      new Map(
        ids.map((tradeId) => [
          tradeId,
          {
            tradeId,
            status: 'CLEAR',
            runKey: anchor.runKey,
            driftCount: 0,
            freshness: 'FRESH',
            completedAt: anchor.completedAt,
            staleRunningRunCount: 0,
            coverageFromBlock: 0,
            coverageToBlock: 110,
            coverageComplete: true,
            blockedReasons: [],
          },
        ]),
      ),
  };
}
