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
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('aggregates trade KPIs across all indexer pages', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => tradeRecord('LOCKED', index + 1));
    const secondPage = [
      tradeRecord('IN_TRANSIT', 1001),
      tradeRecord('ARRIVAL_CONFIRMED', 1002),
      tradeRecord('CLOSED', 1003),
      tradeRecord('FROZEN', 1004),
    ];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { trades: firstPage } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { trades: secondPage } }),
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
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
