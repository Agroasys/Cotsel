/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryComplianceStore } from '../src/core/complianceStore';
import { OverviewService } from '../src/core/overviewService';

describe('overview service', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('maps overview snapshot from indexer to trade KPIs', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          overviewSnapshotById: {
            totalTrades: 10,
            lockedTrades: 3,
            stage1Trades: 2,
            stage2Trades: 1,
            completedTrades: 2,
            disputedTrades: 1,
            cancelledTrades: 1,
            lastProcessedBlock: '42000',
            lastIndexedAt: '2026-03-09T00:00:00.000Z',
            lastTradeEventAt: '2026-03-08T12:00:00.000Z',
          },
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

    expect(snapshot.kpis.trades.total).toBe(10);
    expect(snapshot.kpis.trades.byStatus.locked).toBe(3);
    expect(snapshot.kpis.trades.byStatus.stage_1).toBe(2);
    expect(snapshot.kpis.trades.byStatus.stage_2).toBe(1);
    expect(snapshot.kpis.trades.byStatus.completed).toBe(2);
    expect(snapshot.kpis.trades.byStatus.disputed).toBe(1);
    expect(snapshot.kpis.trades.byStatus.cancelled).toBe(1);
    expect(snapshot.feedFreshness.trades.lastProcessedBlock).toBe('42000');
    expect(snapshot.feedFreshness.trades.freshAt).toBe('2026-03-09T00:00:00.000Z');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('marks queriedAt null for feeds that fail during snapshot generation', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('indexer down'));

    const governanceStatusService = {
      getGovernanceStatus: jest.fn().mockRejectedValue(new Error('rpc down')),
      checkReadiness: jest.fn().mockResolvedValue(undefined),
    };

    const complianceStore = {
      ...createInMemoryComplianceStore([]),
      countBlockedTrades: jest.fn().mockRejectedValue(new Error('store down')),
    };

    const service = new OverviewService(
      'http://127.0.0.1:4350/graphql',
      5000,
      governanceStatusService,
      complianceStore,
    );

    const snapshot = await service.getOverview();

    expect(snapshot.feedFreshness.trades).toEqual({
      source: 'indexer_graphql',
      queriedAt: null,
      available: false,
      lastProcessedBlock: null,
      freshAt: null,
    });
    expect(snapshot.feedFreshness.governance).toEqual({
      source: 'chain_rpc',
      queriedAt: null,
      available: false,
    });
    expect(snapshot.feedFreshness.compliance).toEqual({
      source: 'gateway_ledger',
      queriedAt: null,
      available: false,
    });
  });
});
