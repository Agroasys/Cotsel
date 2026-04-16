process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import type { Request, Response } from 'express';
import { TreasuryEligibilityService } from '../src/core/exportEligibility';
import { ReconciliationGateService } from '../src/core/reconciliationGate';
import type { LedgerEntryWithState } from '../src/types';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  listDistinctLedgerTradeIds: jest.fn(),
}));

type QueryResult<Row> = { rows: Row[] };
type ReconciliationGatePool = NonNullable<
  ConstructorParameters<typeof ReconciliationGateService>[0]
>['pool'];

function createPoolMock(
  handlers: Record<string, () => QueryResult<unknown>>,
): NonNullable<ReconciliationGatePool> {
  return {
    query: jest.fn(async (queryText: string | { text?: string }) => {
      const sql = typeof queryText === 'string' ? queryText : (queryText.text ?? '');

      for (const [matcher, handler] of Object.entries(handlers)) {
        if (sql.includes(matcher)) {
          return handler();
        }
      }

      throw new Error(`Unexpected query: ${sql}`);
    }) as unknown as NonNullable<ReconciliationGatePool>['query'],
  };
}

function makeEntry(overrides?: Partial<LedgerEntryWithState>): LedgerEntryWithState {
  return {
    id: overrides?.id ?? 1,
    entry_key: overrides?.entry_key ?? 'entry-1',
    trade_id: overrides?.trade_id ?? 'trade-1',
    tx_hash: overrides?.tx_hash ?? '0xtx-1',
    block_number: overrides?.block_number ?? 100,
    event_name: overrides?.event_name ?? 'PlatformFeesPaidStage1',
    component_type: overrides?.component_type ?? 'PLATFORM_FEE',
    amount_raw: overrides?.amount_raw ?? '42',
    source_timestamp: overrides?.source_timestamp ?? new Date('2026-03-31T00:00:00.000Z'),
    metadata: overrides?.metadata ?? {},
    created_at: overrides?.created_at ?? new Date('2026-03-31T00:00:00.000Z'),
    latest_state: overrides?.latest_state ?? 'READY_FOR_EXTERNAL_HANDOFF',
    latest_state_at: overrides?.latest_state_at ?? new Date('2026-03-31T00:00:00.000Z'),
  };
}

function mockResponse(): Response & {
  status: jest.MockedFunction<(code: number) => Response>;
  json: jest.MockedFunction<(body: unknown) => Response>;
} {
  const response = {} as Response & {
    status: jest.MockedFunction<(code: number) => Response>;
    json: jest.MockedFunction<(body: unknown) => Response>;
  };
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

describe('Ledger Abstraction Proof', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('clean path keeps payout and export eligibility clear only after fresh reconciliation', async () => {
    const gate = new ReconciliationGateService({
      pool: createPoolMock({
        "WHERE status = 'COMPLETED'": () => ({
          rows: [{ run_key: 'run-clean', completed_at: new Date('2026-03-31T00:20:00.000Z') }],
        }),
        "WHERE status = 'RUNNING'": () => ({ rows: [{ count: '0' }] }),
        'FROM reconcile_run_trades': () => ({ rows: [{ trade_id: 'trade-1' }] }),
        'FROM reconcile_drifts': () => ({ rows: [] }),
      }),
      now: () => new Date('2026-03-31T00:25:00.000Z'),
      maxAgeSeconds: 900,
      maxRunningRunAgeSeconds: 900,
    });
    const tradeGate = await gate.assessTrades(['trade-1']);
    const eligibility = new TreasuryEligibilityService({
      provider: {
        getBlock: async () => ({ number: 150n }),
      },
      reconciliationGate: gate,
    });
    const entryGate = await eligibility.assessEntries([makeEntry({ trade_id: 'trade-1' })]);

    expect(tradeGate.get('trade-1')).toEqual(
      expect.objectContaining({
        status: 'CLEAR',
        freshness: 'FRESH',
        blockedReasons: [],
      }),
    );
    expect(entryGate.get(1)).toEqual(
      expect.objectContaining({
        confirmationStage: 'FINALIZED',
        reconciliationStatus: 'CLEAR',
        eligibleForPayout: true,
        eligibleForExport: true,
      }),
    );
  });

  test('drift path fails closed and exposes control-summary state for upstream operators', async () => {
    const { TreasuryController } = await import('../src/api/controller');
    const { listDistinctLedgerTradeIds } = await import('../src/database/queries');

    jest.mocked(listDistinctLedgerTradeIds).mockResolvedValue(['trade-1', 'trade-2']);
    const controller = new TreasuryController();
    const reconciliationGate = (
      controller as unknown as { reconciliationGate: ReconciliationGateService }
    ).reconciliationGate;
    jest.spyOn(reconciliationGate, 'summarizeTrades').mockResolvedValue({
      status: 'BLOCKED',
      freshness: 'FRESH',
      latestCompletedRunKey: 'run-drift',
      latestCompletedRunAt: new Date('2026-03-31T00:21:00.000Z'),
      latestCompletedRunAgeSeconds: 240,
      staleRunningRunCount: 0,
      trackedTradeCount: 2,
      clearTradeCount: 1,
      blockedTradeCount: 1,
      unknownTradeCount: 0,
      driftBlockedTradeCount: 1,
      blockedReasons: ['Latest reconciliation run reported 1 drift finding(s)'],
    });

    const eligibility = new TreasuryEligibilityService({
      provider: {
        getBlock: async () => ({ number: 150n }),
      },
      reconciliationGate: {
        assessTrades: async () =>
          new Map([
            [
              'trade-1',
              {
                tradeId: 'trade-1',
                status: 'BLOCKED',
                runKey: 'run-drift',
                driftCount: 1,
                freshness: 'FRESH',
                completedAt: new Date('2026-03-31T00:21:00.000Z'),
                staleRunningRunCount: 0,
                blockedReasons: ['Latest reconciliation run reported 1 drift finding(s)'],
              },
            ],
          ]),
      } as unknown as ReconciliationGateService,
    });
    const entryGate = await eligibility.assessEntries([makeEntry({ trade_id: 'trade-1' })]);

    const response = mockResponse();
    await controller.getReconciliationControlSummary({} as Request, response);

    expect(entryGate.get(1)).toEqual(
      expect.objectContaining({
        reconciliationStatus: 'BLOCKED',
        eligibleForPayout: false,
        eligibleForExport: false,
      }),
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          status: 'BLOCKED',
          driftBlockedTradeCount: 1,
          blockedReasons: ['Latest reconciliation run reported 1 drift finding(s)'],
        }),
      }),
    );
  });

  test('unknown-scope reconciliation remains fail-closed and visible as an upstream control gap', async () => {
    const gate = new ReconciliationGateService({
      pool: createPoolMock({
        "WHERE status = 'COMPLETED'": () => ({
          rows: [{ run_key: 'run-unknown', completed_at: new Date('2026-03-31T00:20:00.000Z') }],
        }),
        "WHERE status = 'RUNNING'": () => ({ rows: [{ count: '0' }] }),
        'FROM reconcile_run_trades': () => ({ rows: [] }),
        'FROM reconcile_drifts': () => ({ rows: [] }),
      }),
      now: () => new Date('2026-03-31T00:25:00.000Z'),
      maxAgeSeconds: 900,
      maxRunningRunAgeSeconds: 900,
    });
    const tradeGate = await gate.assessTrades(['trade-404']);
    const summary = await gate.summarizeTrades(['trade-404']);
    const eligibility = new TreasuryEligibilityService({
      provider: {
        getBlock: async () => ({ number: 150n }),
      },
      reconciliationGate: gate,
    });
    const entryGate = await eligibility.assessEntries([makeEntry({ trade_id: 'trade-404' })]);

    expect(tradeGate.get('trade-404')).toEqual(
      expect.objectContaining({
        status: 'UNKNOWN',
        freshness: 'FRESH',
        blockedReasons: ['Trade is not covered by the latest completed reconciliation run'],
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        status: 'UNKNOWN',
        unknownTradeCount: 1,
      }),
    );
    expect(entryGate.get(1)).toEqual(
      expect.objectContaining({
        reconciliationStatus: 'UNKNOWN',
        eligibleForPayout: false,
        eligibleForExport: false,
      }),
    );
  });
});
