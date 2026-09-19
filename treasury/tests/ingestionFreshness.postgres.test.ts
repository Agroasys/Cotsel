/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-10 acceptance drill, against a real PostgreSQL instance.
 *
 * The claim under test is that treasury cannot remain green while its chain
 * evidence stops advancing, and that the repair is provable afterwards. That
 * claim lives in the schema as much as in the code -- an append-only run log, a
 * constraint that refuses to record coverage a run did not prove, and a real
 * advisory lock deciding which replica owns the schedule -- so a mocked pool
 * would demonstrate none of it.
 */
import { Pool } from 'pg';
import {
  applyTreasuryTestEnv,
  provisionTreasuryDatabase,
  runPostgresIntegrationTests,
} from './helpers/treasuryPostgres';
import type { TreasuryIngestionResult } from '../src/core/ingestion';

type IngestionQueries = typeof import('../src/database/queries/ingestion');
type IngestionWorkerModule = typeof import('../src/core/ingestionWorker');
type IngestionFreshnessModule = typeof import('../src/core/ingestionFreshness');
type TreasuryConnection = typeof import('../src/database/connection');

const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

const CURSORS = ['trade_events', 'claim_events'];

/**
 * The overlap test needs one run held open while a second replica tries to
 * take the lease, which is the only way to observe the lock actually deciding.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve: () => resolve() };
}

function completedResult(
  overrides: Partial<TreasuryIngestionResult> = {},
): TreasuryIngestionResult {
  return {
    fetched: 2,
    inserted: 2,
    stableBlockNumber: 1000,
    indexerProcessedBlockNumber: 990,
    ingestedThroughBlockNumber: 990,
    nextTradeBlockNumber: 991,
    nextClaimBlockNumber: 991,
    windowExhausted: true,
    blockedReason: null,
    ...overrides,
  };
}

describePostgres('treasury stopped-ingestion drill (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: IngestionQueries;
  let workerModule: IngestionWorkerModule;
  let freshnessModule: IngestionFreshnessModule;
  let connection: TreasuryConnection;
  let sidecar: Pool;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_ingest_freshness');
    cleanup = provisioned.cleanup;
    applyTreasuryTestEnv(provisioned.dbName);

    jest.resetModules();
    queries = await import('../src/database/queries/ingestion');
    workerModule = await import('../src/core/ingestionWorker');
    freshnessModule = await import('../src/core/ingestionFreshness');
    connection = await import('../src/database/connection');

    sidecar = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: provisioned.dbName,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
  });

  afterAll(async () => {
    await sidecar?.end();
    await connection?.closeConnection();
    await cleanup?.();
  });

  beforeEach(async () => {
    // TRUNCATE rather than DELETE: the run log's append-only trigger refuses a
    // row-level delete, which is the guarantee two of these cases assert.
    await sidecar.query('TRUNCATE treasury_ingestion_runs RESTART IDENTITY');
    await sidecar.query('TRUNCATE treasury_ingestion_state');
  });

  function makeWorker(ingestOnce: () => Promise<TreasuryIngestionResult>, identity: string) {
    return new workerModule.TreasuryIngestionWorker({
      ingestion: { ingestOnce },
      pool: connection.pool,
      intervalMs: 60_000,
      workerIdentity: identity,
    });
  }

  function makeFreshness(now: Date, maxAgeSeconds = 900) {
    return new freshnessModule.TreasuryIngestionFreshnessService({
      now: () => now,
      maxAgeSeconds,
      maxLagBlocks: 300,
    });
  }

  it('starts unproven: a migrated database has not yet earned a fresh verdict', async () => {
    await queries.markIngestionAttemptStarted(CURSORS);

    const assessment = await makeFreshness(new Date()).assess();

    expect(assessment.status).toBe('NEVER_RUN');
    expect(assessment.lastSuccessAt).toBeNull();
  });

  it('turns fresh after a completed run and records the window it proved', async () => {
    const worker = makeWorker(async () => completedResult(), 'worker-a:1');

    const run = await worker.runOnce('WORKER');
    const assessment = await makeFreshness(new Date()).assess({ stableBlockNumber: 1000 });

    expect(run.outcome).toBe('COMPLETED');
    expect(assessment.status).toBe('FRESH');

    const runs = await sidecar.query(
      `SELECT outcome, ingested_through_block_number, worker_identity, trigger_source
       FROM treasury_ingestion_runs`,
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].outcome).toBe('COMPLETED');
    expect(Number(runs.rows[0].ingested_through_block_number)).toBe(990);
    expect(runs.rows[0].worker_identity).toBe('worker-a:1');
  });

  /**
   * The drill proper. Ingestion stops; nothing about the stored evidence
   * changes; the clock does the rest. What must move is the verdict, not the
   * data.
   */
  it('goes stale and blocks once the ingester stops, naming the refusal', async () => {
    const worker = makeWorker(async () => completedResult(), 'worker-a:1');
    await worker.runOnce('WORKER');

    const blocked = makeWorker(
      async () =>
        completedResult({
          fetched: 0,
          inserted: 0,
          ingestedThroughBlockNumber: null,
          blockedReason: 'Settlement RPC did not report a finalized head',
        }),
      'worker-a:1',
    );
    await blocked.runOnce('WORKER');
    await blocked.runOnce('WORKER');

    const oneHourLater = new Date(Date.now() + 3600 * 1000);
    const assessment = await makeFreshness(oneHourLater).assess();

    expect(assessment.status).toBe('STALE');
    expect(assessment.consecutiveFailureCount).toBe(2);
    expect(assessment.blockedReasons).toContain(
      'Last ingestion attempt was refused: Settlement RPC did not report a finalized head',
    );
  });

  it('clears the failure counter and the refusal only when a run completes', async () => {
    const blocked = makeWorker(
      async () =>
        completedResult({
          ingestedThroughBlockNumber: null,
          blockedReason: 'Indexer did not report a processed block height',
        }),
      'worker-a:1',
    );
    await blocked.runOnce('WORKER');

    const repaired = makeWorker(async () => completedResult(), 'worker-a:1');
    await repaired.runOnce('WORKER');

    const states = await queries.listIngestionCursorStates(CURSORS);
    for (const state of states) {
      expect(state.consecutiveFailureCount).toBe(0);
      expect(state.lastBlockedReason).toBeNull();
      expect(state.lastSuccessAt).not.toBeNull();
    }

    const assessment = await makeFreshness(new Date()).assess();
    expect(assessment.status).toBe('FRESH');
  });

  /**
   * Backfill after repair. The operator-run command takes the same lease and
   * advances the same watermark, so a repaired outage shows as repaired rather
   * than leaving readiness red on data that is actually current.
   */
  it('accepts an operator backfill through the same lease and watermark', async () => {
    const blocked = makeWorker(
      async () => completedResult({ ingestedThroughBlockNumber: null, blockedReason: 'stopped' }),
      'worker-a:1',
    );
    await blocked.runOnce('WORKER');

    const backfill = makeWorker(async () => completedResult(), 'operator-cli:9');
    const run = await backfill.runOnce('CLI');

    expect(run.outcome).toBe('COMPLETED');
    const assessment = await makeFreshness(new Date()).assess();
    expect(assessment.status).toBe('FRESH');

    const runs = await sidecar.query(
      `SELECT trigger_source, outcome FROM treasury_ingestion_runs ORDER BY id`,
    );
    expect(runs.rows.map((row: { trigger_source: string }) => row.trigger_source)).toEqual([
      'WORKER',
      'CLI',
    ]);
  });

  it('lets only one replica own the schedule at a time', async () => {
    const firstRunning = deferred();
    const firstHasStarted = deferred();

    const slowWorker = makeWorker(async () => {
      firstHasStarted.resolve();
      await firstRunning.promise;
      return completedResult();
    }, 'worker-a:1');
    const secondIngest = jest.fn(async () => completedResult());
    const secondWorker = makeWorker(secondIngest, 'worker-b:1');

    const firstRun = slowWorker.runOnce('WORKER');
    await firstHasStarted.promise;
    const secondRun = await secondWorker.runOnce('WORKER');
    firstRunning.resolve();

    expect((await firstRun).outcome).toBe('COMPLETED');
    expect(secondRun.outcome).toBe('NOT_OWNER');
    expect(secondIngest).not.toHaveBeenCalled();

    const declined = await sidecar.query(
      `SELECT worker_identity FROM treasury_ingestion_runs WHERE outcome = 'NOT_OWNER'`,
    );
    expect(declined.rows).toHaveLength(1);
    expect(declined.rows[0].worker_identity).toBe('worker-b:1');
  });

  /**
   * A run capped by `TREASURY_INGEST_MAX_EVENTS` read everything it claims to
   * have read, but did not reach the end of its window. Advancing freshness
   * here reported a permanently-behind ingester as level with the chain -- the
   * same false-green this control removes, produced by a worker that is running
   * rather than one that stopped.
   */
  it('does not turn fresh on a run that stopped short of its window', async () => {
    const worker = makeWorker(
      async () => completedResult({ windowExhausted: false, ingestedThroughBlockNumber: 600 }),
      'worker-a:1',
    );

    const run = await worker.runOnce('WORKER');
    const assessment = await makeFreshness(new Date()).assess({ stableBlockNumber: 1000 });

    expect(run.outcome).toBe('PARTIAL');
    expect(assessment.status).toBe('NEVER_RUN');
  });

  it('records the coverage a capped run reached, not the window it targeted', async () => {
    const worker = makeWorker(
      async () => completedResult({ windowExhausted: false, ingestedThroughBlockNumber: 600 }),
      'worker-a:1',
    );

    await worker.runOnce('WORKER');

    const runs = await sidecar.query(
      `SELECT outcome, ingested_through_block_number FROM treasury_ingestion_runs`,
    );
    expect(runs.rows[0].outcome).toBe('PARTIAL');
    expect(Number(runs.rows[0].ingested_through_block_number)).toBe(600);
  });

  it('turns fresh once a later run finishes the window', async () => {
    const capped = makeWorker(
      async () => completedResult({ windowExhausted: false, ingestedThroughBlockNumber: 600 }),
      'worker-a:1',
    );
    await capped.runOnce('WORKER');

    const caughtUp = makeWorker(async () => completedResult(), 'worker-a:1');
    await caughtUp.runOnce('WORKER');

    const assessment = await makeFreshness(new Date()).assess({ stableBlockNumber: 1000 });
    expect(assessment.status).toBe('FRESH');
  });

  it('refuses to rewrite or delete a recorded run', async () => {
    const worker = makeWorker(async () => completedResult(), 'worker-a:1');
    await worker.runOnce('WORKER');

    await expect(
      sidecar.query(`UPDATE treasury_ingestion_runs SET outcome = 'COMPLETED'`),
    ).rejects.toThrow(/append-only/);
    await expect(sidecar.query('DELETE FROM treasury_ingestion_runs')).rejects.toThrow(
      /append-only/,
    );
  });

  /**
   * A refused run that carried a coverage height would let a reader reconstruct
   * a window nothing actually read, which is the false-completion this whole
   * work package is about.
   */
  it('refuses to record coverage for a run that did not complete', async () => {
    await expect(
      queries.recordIngestionRun({
        runKey: '00000000-0000-4000-8000-000000000001',
        workerIdentity: 'worker-a:1',
        triggerSource: 'WORKER',
        outcome: 'BLOCKED',
        fetched: 0,
        inserted: 0,
        stableBlockNumber: 1000,
        indexerProcessedBlockNumber: 990,
        ingestedThroughBlockNumber: 990,
        nextTradeBlockNumber: null,
        nextClaimBlockNumber: null,
        blockedReason: 'stopped',
        durationMs: 10,
        startedAt: new Date(),
      }),
    ).rejects.toThrow(/treasury_ingestion_runs_outcome_consistent/);
  });

  it('refuses to record a completed run that still carries a blocked reason', async () => {
    await expect(
      queries.recordIngestionRun({
        runKey: '00000000-0000-4000-8000-000000000002',
        workerIdentity: 'worker-a:1',
        triggerSource: 'WORKER',
        outcome: 'COMPLETED',
        fetched: 1,
        inserted: 1,
        stableBlockNumber: 1000,
        indexerProcessedBlockNumber: 990,
        ingestedThroughBlockNumber: 990,
        nextTradeBlockNumber: 991,
        nextClaimBlockNumber: 991,
        blockedReason: 'stopped',
        durationMs: 10,
        startedAt: new Date(),
      }),
    ).rejects.toThrow(/treasury_ingestion_runs_outcome_consistent/);
  });
});
