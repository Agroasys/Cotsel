process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import { ReconciliationGateService } from '../src/core/reconciliationGate';

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

describe('ReconciliationGateService', () => {
  test('blocks trades when no completed reconciliation run exists', async () => {
    const pool = createPoolMock({
      "WHERE status = 'COMPLETED'": () => ({ rows: [] }),
      "WHERE status = 'RUNNING'": () => ({
        rows: [{ count: '0' }],
      }),
    });
    const service = new ReconciliationGateService({
      pool,
      now: () => new Date('2026-03-31T00:15:00.000Z'),
    });

    const result = await service.assessTrades(['trade-1']);
    const gate = result.get('trade-1');

    expect(gate).toEqual({
      tradeId: 'trade-1',
      status: 'BLOCKED',
      runKey: null,
      driftCount: 0,
      freshness: 'MISSING',
      completedAt: null,
      staleRunningRunCount: 0,
      blockedReasons: ['No completed reconciliation run is available'],
    });
  });

  test('blocks trades when reconciliation freshness is stale', async () => {
    const completedAt = new Date('2026-03-31T00:00:00.000Z');
    const pool = createPoolMock({
      "WHERE status = 'COMPLETED'": () => ({
        rows: [{ run_key: 'run-1', completed_at: completedAt }],
      }),
      "WHERE status = 'RUNNING'": () => ({
        rows: [{ count: '1' }],
      }),
      'FROM reconcile_run_trades': () => ({
        rows: [{ trade_id: 'trade-1' }],
      }),
      'FROM reconcile_drifts': () => ({
        rows: [],
      }),
    });
    const service = new ReconciliationGateService({
      pool,
      now: () => new Date('2026-03-31T00:30:01.000Z'),
      maxAgeSeconds: 900,
      maxRunningRunAgeSeconds: 900,
    });

    const result = await service.assessTrades(['trade-1']);
    const gate = result.get('trade-1');

    expect(gate).toEqual({
      tradeId: 'trade-1',
      status: 'BLOCKED',
      runKey: 'run-1',
      driftCount: 0,
      freshness: 'STALE',
      completedAt,
      staleRunningRunCount: 1,
      blockedReasons: [
        'Latest completed reconciliation run is older than 900 seconds',
        '1 reconciliation run(s) have remained RUNNING beyond 900 seconds',
      ],
    });
  });

  test('clears trades only when fresh, in scope, and drift free', async () => {
    const completedAt = new Date('2026-03-31T00:20:00.000Z');
    const pool = createPoolMock({
      "WHERE status = 'COMPLETED'": () => ({
        rows: [{ run_key: 'run-2', completed_at: completedAt }],
      }),
      "WHERE status = 'RUNNING'": () => ({
        rows: [{ count: '0' }],
      }),
      'FROM reconcile_run_trades': () => ({
        rows: [{ trade_id: 'trade-1' }],
      }),
      'FROM reconcile_drifts': () => ({
        rows: [],
      }),
    });
    const service = new ReconciliationGateService({
      pool,
      now: () => new Date('2026-03-31T00:25:00.000Z'),
      maxAgeSeconds: 900,
      maxRunningRunAgeSeconds: 900,
    });

    const result = await service.assessTrades(['trade-1']);
    const gate = result.get('trade-1');

    expect(gate).toEqual({
      tradeId: 'trade-1',
      status: 'CLEAR',
      runKey: 'run-2',
      driftCount: 0,
      freshness: 'FRESH',
      completedAt,
      staleRunningRunCount: 0,
      blockedReasons: [],
    });
  });
});
