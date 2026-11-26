process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import { ReconciliationGateService } from '../src/core/reconciliationGate';
import type { RunEvidenceVerifier } from '../src/core/reconciliationEvidenceGate';

// The mocked pools model runs whose signed manifest verifies (Cotsel#951); the
// verification itself runs against PostgreSQL in the reconciliation suite.
const signedRun: RunEvidenceVerifier = async () => ({ ok: true, manifest: {} as never });

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
  test('reads a fresh reconciliation anchor for an export with no trades', async () => {
    const pool = createPoolMock({
      "status='COMPLETED'": () => ({
        rows: [
          {
            run_key: 'run-1',
            completed_at: new Date('2026-03-31T00:10:00Z'),
            coverage_from_block: '0',
            coverage_to_block: '110',
            coverage_complete: true,
          },
        ],
      }),
      "status='RUNNING'": () => ({ rows: [{ count: '0' }] }),
    });
    const service = new ReconciliationGateService({
      pool,
      verifyRun: signedRun,
      now: () => new Date('2026-03-31T00:15:00Z'),
    });
    expect(await service.snapshotRunAnchor()).toMatchObject({
      runKey: 'run-1',
      coverageToBlock: 110,
      coverageComplete: true,
    });
  });

  test('refuses a reconciliation run with a future completion timestamp', async () => {
    const pool = createPoolMock({
      "WHERE status = 'COMPLETED'": () => ({
        rows: [
          {
            run_key: 'run-1',
            completed_at: new Date('2026-03-31T00:30:00Z'),
            coverage_from_block: 0,
            coverage_to_block: 110,
            coverage_complete: true,
          },
        ],
      }),
      "WHERE status = 'RUNNING'": () => ({ rows: [{ count: '0' }] }),
      'FROM reconcile_run_trades': () => ({ rows: [{ trade_id: 'trade-1' }] }),
      'FROM reconcile_drifts': () => ({ rows: [] }),
    });
    const gate = (
      await new ReconciliationGateService({
        pool,
        verifyRun: signedRun,
        now: () => new Date('2026-03-31T00:15:00Z'),
      }).assessTrades(['trade-1'])
    ).get('trade-1');
    expect(gate?.status).toBe('BLOCKED');
    expect(gate?.freshness).toBe('STALE');
    expect(gate?.blockedReasons).toContain(
      'Latest completed reconciliation run has a future completion timestamp',
    );
  });

  test('blocks trades when no completed reconciliation run exists', async () => {
    const pool = createPoolMock({
      "WHERE status = 'COMPLETED'": () => ({ rows: [] }),
      "WHERE status = 'RUNNING'": () => ({
        rows: [{ count: '0' }],
      }),
    });
    const service = new ReconciliationGateService({
      pool,
      verifyRun: signedRun,
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
      coverageFromBlock: null,
      coverageToBlock: null,
      coverageComplete: null,
      blockedReasons: ['No completed reconciliation run is available'],
    });
  });

  test('blocks trades when reconciliation freshness is stale', async () => {
    const completedAt = new Date('2026-03-31T00:00:00.000Z');
    const pool = createPoolMock({
      "WHERE status = 'COMPLETED'": () => ({
        rows: [
          {
            run_key: 'run-1',
            completed_at: completedAt,
            coverage_from_block: '0',
            coverage_to_block: '1000000',
            coverage_complete: true,
          },
        ],
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
      verifyRun: signedRun,
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
      coverageFromBlock: 0,
      coverageToBlock: 1_000_000,
      coverageComplete: true,
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
        rows: [
          {
            run_key: 'run-2',
            completed_at: completedAt,
            coverage_from_block: '0',
            coverage_to_block: '1000000',
            coverage_complete: true,
          },
        ],
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
      verifyRun: signedRun,
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
      coverageFromBlock: 0,
      coverageToBlock: 1_000_000,
      coverageComplete: true,
      blockedReasons: [],
    });
  });
  describe('signed evidence (Cotsel#951)', () => {
    const cleanRunPool = () =>
      createPoolMock({
        "WHERE status = 'COMPLETED'": () => ({
          rows: [
            {
              run_key: 'run-2',
              completed_at: new Date('2026-03-31T00:20:00.000Z'),
              coverage_from_block: '0',
              coverage_to_block: '1000000',
              coverage_complete: true,
            },
          ],
        }),
        "WHERE status = 'RUNNING'": () => ({ rows: [{ count: '0' }] }),
        "status='COMPLETED'": () => ({
          rows: [
            {
              run_key: 'run-2',
              completed_at: new Date('2026-03-31T00:20:00.000Z'),
              coverage_from_block: '0',
              coverage_to_block: '1000000',
              coverage_complete: true,
            },
          ],
        }),
        "status='RUNNING'": () => ({ rows: [{ count: '0' }] }),
        'FROM reconcile_run_trades': () => ({ rows: [{ trade_id: 'trade-1' }] }),
        'FROM reconcile_drifts': () => ({ rows: [] }),
      });
    const gateWith = (verifyRun: RunEvidenceVerifier) =>
      new ReconciliationGateService({
        pool: cleanRunPool(),
        verifyRun,
        now: () => new Date('2026-03-31T00:25:00.000Z'),
        maxAgeSeconds: 900,
        maxRunningRunAgeSeconds: 900,
      });

    test.each([
      ['unsigned', 'not signed (reconciliation_evidence_unsigned)'],
      ['findings_mismatch', 'findings_mismatch (reconciliation_evidence_invalid)'],
      ['scope_mismatch', 'scope_mismatch (reconciliation_evidence_invalid)'],
      ['bad_signature', 'bad_signature (reconciliation_evidence_invalid)'],
    ] as const)(
      'a fresh, drift-free trade is blocked when the run is %s',
      async (reason, expected) => {
        const verifyRun = jest.fn<ReturnType<RunEvidenceVerifier>, Parameters<RunEvidenceVerifier>>(
          async () => ({ ok: false, reason }),
        );
        const gate = (await gateWith(verifyRun).assessTrades(['trade-1'])).get('trade-1');
        expect(verifyRun).toHaveBeenCalledWith(expect.anything(), 'run-2');
        expect(gate?.status).toBe('BLOCKED');
        expect(gate?.blockedReasons.join(' ')).toContain(expected);
      },
    );

    test('an empty export cannot anchor on a run whose evidence does not verify', async () => {
      await expect(
        gateWith(async () => ({ ok: false, reason: 'run_mismatch' })).snapshotRunAnchor(),
      ).rejects.toThrow('reconciliation_evidence_invalid');
      await expect(gateWith(signedRun).snapshotRunAnchor()).resolves.toMatchObject({
        runKey: 'run-2',
      });
    });
  });
});
