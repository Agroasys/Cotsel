/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryComplianceStore } from '../src/core/complianceStore';
import { OverviewService } from '../src/core/overviewService';

function tradeRecord(status: 'LOCKED' | 'IN_TRANSIT' | 'ARRIVAL_CONFIRMED' | 'FROZEN' | 'CLOSED', id: number) {
  return { tradeId: `TRD-${id}`, status };
}

describe('overview service', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('returns authoritative trade KPIs from the indexer overview snapshot', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            overviewSnapshots: [{
              totalTrades: 1004,
              lockedTrades: 1000,
              stage1Trades: 1,
              stage2Trades: 1,
              completedTrades: 1,
              disputedTrades: 1,
              cancelledTrades: 0,
              lastProcessedBlock: '123456',
              lastIndexedAt: '2026-03-09T00:00:00.000Z',
              lastTradeEventAt: '2026-03-09T00:00:00.000Z',
            }],
          },
        }),
      } as Response);

    const governanceStatusService = {
      getGovernanceStatus: jest.fn().mockResolvedValue({
        paused: false,
        claimsPaused: false,
        oracleActive: true,
      }),
      checkReadiness: jest.fn().mockResolvedValue(undefined),
    };

    const service = new OverviewService(
      'http://127.0.0.1:4350/graphql',
      5000,
      governanceStatusService,
      createInMemoryComplianceStore([]),
    );

    const snapshot = await service.getOverview();

    expect(snapshot.kpis.trades.total).toBe(1004);
    expect(snapshot.kpis.trades.byStatus.locked).toBe(1000);
    expect(snapshot.kpis.trades.byStatus.stage_1).toBe(1);
    expect(snapshot.kpis.trades.byStatus.stage_2).toBe(1);
    expect(snapshot.kpis.trades.byStatus.completed).toBe(1);
    expect(snapshot.kpis.trades.byStatus.disputed).toBe(1);
    expect(snapshot.feedFreshness.trades).toEqual({
      source: 'indexer',
      freshAt: '2026-03-09T00:00:00.000Z',
      queriedAt: expect.any(String),
      available: true,
    });
    expect(snapshot.errors).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('returns degraded feed metadata and source errors when snapshot generation fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('indexer down'));

    const governanceStatusService = {
      getGovernanceStatus: jest.fn().mockRejectedValue(new Error('rpc down')),
      checkReadiness: jest.fn().mockResolvedValue(undefined),
    };

    const complianceStore = {
      ...createInMemoryComplianceStore([]),
      getOverviewMetrics: jest.fn().mockRejectedValue(new Error('store down')),
    };

    const service = new OverviewService(
      'http://127.0.0.1:4350/graphql',
      5000,
      governanceStatusService,
      complianceStore,
    );

    const snapshot = await service.getOverview();

    expect(snapshot.feedFreshness.trades).toEqual({
      source: 'indexer',
      freshAt: null,
      queriedAt: null,
      available: false,
    });
    expect(snapshot.feedFreshness.governance).toEqual({
      source: 'governance',
      freshAt: null,
      queriedAt: null,
      available: false,
    });
    expect(snapshot.feedFreshness.compliance).toEqual({
      source: 'compliance',
      freshAt: null,
      queriedAt: null,
      available: false,
    });
    expect(snapshot.errors).toEqual([
      { source: 'indexer', code: 'UPSTREAM_UNAVAILABLE', message: 'Indexer overview request failed' },
      { source: 'governance', code: 'UPSTREAM_UNAVAILABLE', message: 'rpc down' },
      { source: 'compliance', code: 'UPSTREAM_UNAVAILABLE', message: 'store down' },
    ]);
  });

  test('treats a missing indexer snapshot as unavailable instead of fabricating freshness', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { overviewSnapshots: [] } }),
    } as Response);

    const governanceStatusService = {
      getGovernanceStatus: jest.fn().mockResolvedValue({
        paused: false,
        claimsPaused: false,
        oracleActive: true,
        chainBlockTimestamp: '2026-03-09T00:00:00.000Z',
        queriedAt: '2026-03-09T00:00:01.000Z',
      }),
      checkReadiness: jest.fn().mockResolvedValue(undefined),
    };

    const service = new OverviewService(
      'http://127.0.0.1:4350/graphql',
      5000,
      governanceStatusService,
      createInMemoryComplianceStore([]),
    );

    const snapshot = await service.getOverview();

    expect(snapshot.kpis.trades).toEqual({
      total: 0,
      byStatus: { locked: 0, stage_1: 0, stage_2: 0, completed: 0, disputed: 0 },
    });
    expect(snapshot.feedFreshness.trades.available).toBe(false);
    expect(snapshot.errors).toContainEqual({
      source: 'indexer',
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Indexer overview snapshot is missing',
    });
  });

  test('captures compliance queriedAt at compliance read time instead of response assembly time', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          overviewSnapshots: [{
            totalTrades: 1,
            lockedTrades: 1,
            stage1Trades: 0,
            stage2Trades: 0,
            completedTrades: 0,
            disputedTrades: 0,
            cancelledTrades: 0,
            lastProcessedBlock: '123456',
            lastIndexedAt: '2026-03-10T12:00:00.000Z',
            lastTradeEventAt: '2026-03-10T12:00:00.000Z',
          }],
        },
      }),
    } as Response);

    const governanceStatusService = {
      getGovernanceStatus: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                paused: false,
                claimsPaused: false,
                oracleActive: true,
                chainBlockTimestamp: '2026-03-10T12:00:05.000Z',
                queriedAt: '2026-03-10T12:00:05.000Z',
              });
            }, 5_000);
          }),
      ),
      checkReadiness: jest.fn().mockResolvedValue(undefined),
    };

    const complianceStore = {
      ...createInMemoryComplianceStore([]),
      getOverviewMetrics: jest.fn().mockResolvedValue({
        blockedTrades: 0,
        freshAt: null,
      }),
    };

    const service = new OverviewService(
      'http://127.0.0.1:4350/graphql',
      5000,
      governanceStatusService,
      complianceStore,
    );

    const pending = service.getOverview();
    await jest.advanceTimersByTimeAsync(5_000);
    const snapshot = await pending;

    expect(snapshot.feedFreshness.compliance.queriedAt).toBe('2026-03-10T12:00:00.000Z');
    expect(snapshot.feedFreshness.governance.queriedAt).toBe('2026-03-10T12:00:05.000Z');
  });
});
