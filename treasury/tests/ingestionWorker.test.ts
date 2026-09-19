const mockMarkAttemptStarted = jest.fn();
const mockMarkRunCompleted = jest.fn();
const mockMarkRunPartial = jest.fn();
const mockMarkRunUnsuccessful = jest.fn();
const mockRecordIngestionRun = jest.fn();

jest.mock('../src/database/queries/ingestion', () => ({
  markIngestionAttemptStarted: mockMarkAttemptStarted,
  markIngestionRunCompleted: mockMarkRunCompleted,
  markIngestionRunPartial: mockMarkRunPartial,
  markIngestionRunUnsuccessful: mockMarkRunUnsuccessful,
  recordIngestionRun: mockRecordIngestionRun,
}));

jest.mock('../src/database/connection', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));

process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import { TreasuryIngestionWorker } from '../src/core/ingestionWorker';
import type { TreasuryIngestionResult } from '../src/core/ingestion';

const WORKER_IDENTITY = 'treasury-test:1';

function completedResult(
  overrides: Partial<TreasuryIngestionResult> = {},
): TreasuryIngestionResult {
  return {
    fetched: 4,
    inserted: 3,
    stableBlockNumber: 1000,
    indexerProcessedBlockNumber: 980,
    ingestedThroughBlockNumber: 980,
    nextTradeBlockNumber: 981,
    nextClaimBlockNumber: 981,
    windowExhausted: true,
    blockedReason: null,
    ...overrides,
  };
}

function createPool(options?: { acquired?: boolean }) {
  const acquired = options?.acquired ?? true;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ acquired }] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const release = jest.fn();
  const connect = jest.fn(async () => ({ query, release }));

  return {
    pool: { connect } as never,
    query,
    release,
    connect,
  };
}

function makeWorker(
  ingestOnce: () => Promise<TreasuryIngestionResult>,
  poolOptions?: { acquired?: boolean },
) {
  const harness = createPool(poolOptions);
  const worker = new TreasuryIngestionWorker({
    ingestion: { ingestOnce },
    pool: harness.pool,
    intervalMs: 1000,
    workerIdentity: WORKER_IDENTITY,
  });

  return { worker, ...harness };
}

/**
 * WP-4 B-09 / FAIL-10.
 *
 * Two properties. Only one owner ingests at a time, and every attempt leaves
 * evidence -- including the attempts that ingested nothing. The second is what
 * makes a stopped ingester visible: a worker that only recorded successes would
 * fall silent in exactly the same way whether it stopped or had nothing to do.
 */
describe('TreasuryIngestionWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMarkAttemptStarted.mockResolvedValue(undefined);
    mockMarkRunCompleted.mockResolvedValue(undefined);
    mockMarkRunPartial.mockResolvedValue(undefined);
    mockMarkRunUnsuccessful.mockResolvedValue(undefined);
    mockRecordIngestionRun.mockResolvedValue(undefined);
  });

  it('advances the freshness watermark and records the proven window on a completed run', async () => {
    const { worker, release } = makeWorker(async () => completedResult());

    const run = await worker.runOnce('WORKER');

    expect(run.outcome).toBe('COMPLETED');
    expect(mockMarkAttemptStarted).toHaveBeenCalledWith(['trade_events', 'claim_events']);
    expect(mockMarkRunCompleted).toHaveBeenCalledWith(['trade_events', 'claim_events']);
    expect(mockMarkRunUnsuccessful).not.toHaveBeenCalled();
    expect(mockRecordIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'COMPLETED',
        workerIdentity: WORKER_IDENTITY,
        triggerSource: 'WORKER',
        ingestedThroughBlockNumber: 980,
        blockedReason: null,
        fetched: 4,
        inserted: 3,
      }),
    );
    expect(release).toHaveBeenCalled();
  });

  /**
   * A refusal leaves the watermark where it was. That is the entire mechanism
   * by which a settlement outage eventually blocks export instead of quietly
   * producing empty runs that look like a caught-up ingester.
   */
  it('leaves the freshness watermark untouched when the run refuses to ingest', async () => {
    const { worker } = makeWorker(async () =>
      completedResult({
        fetched: 0,
        inserted: 0,
        ingestedThroughBlockNumber: null,
        blockedReason: 'Settlement RPC did not report a finalized head',
      }),
    );

    const run = await worker.runOnce('WORKER');

    expect(run.outcome).toBe('BLOCKED');
    expect(mockMarkRunCompleted).not.toHaveBeenCalled();
    expect(mockMarkRunUnsuccessful).toHaveBeenCalledWith(
      ['trade_events', 'claim_events'],
      'Settlement RPC did not report a finalized head',
    );
  });

  it('records a thrown run as unsuccessful rather than losing the attempt', async () => {
    const { worker, release } = makeWorker(async () => {
      throw new Error('indexer unreachable');
    });

    const run = await worker.runOnce('WORKER');

    expect(run.outcome).toBe('FAILED');
    expect(run.error).toBe('indexer unreachable');
    expect(mockMarkRunCompleted).not.toHaveBeenCalled();
    expect(mockMarkRunUnsuccessful).toHaveBeenCalledWith(
      ['trade_events', 'claim_events'],
      'indexer unreachable',
    );
    expect(mockRecordIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILED', blockedReason: 'indexer unreachable' }),
    );
    expect(release).toHaveBeenCalled();
  });

  it('declines the tick without ingesting when another replica holds the lease', async () => {
    const ingestOnce = jest.fn(async () => completedResult());
    const { worker, release } = makeWorker(ingestOnce, { acquired: false });

    const run = await worker.runOnce('WORKER');

    expect(run.outcome).toBe('NOT_OWNER');
    expect(ingestOnce).not.toHaveBeenCalled();
    expect(mockMarkAttemptStarted).not.toHaveBeenCalled();
    expect(mockMarkRunCompleted).not.toHaveBeenCalled();
    expect(mockMarkRunUnsuccessful).not.toHaveBeenCalled();
    // Declining still leaves evidence: "not my turn" and "not running" must not
    // look the same in the run log.
    expect(mockRecordIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'NOT_OWNER', ingestedThroughBlockNumber: null }),
    );
    expect(release).toHaveBeenCalled();
  });

  it('does not release a lock it never acquired', async () => {
    const { worker, query } = makeWorker(async () => completedResult(), { acquired: false });

    await worker.runOnce('WORKER');

    const unlocked = query.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_unlock'));
    expect(unlocked).toHaveLength(0);
  });

  it('releases the lease after a run that threw', async () => {
    const { worker, query, release } = makeWorker(async () => {
      throw new Error('boom');
    });

    await worker.runOnce('WORKER');

    const unlocked = query.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_unlock'));
    expect(unlocked).toHaveLength(1);
    expect(release).toHaveBeenCalled();
  });

  /**
   * A backfill that repaired the data without recording it would leave
   * readiness red, which reads as an unrepaired outage.
   */
  it('advances the same watermark when the run is triggered from the CLI', async () => {
    const { worker } = makeWorker(async () => completedResult());

    const run = await worker.runOnce('CLI');

    expect(run.outcome).toBe('COMPLETED');
    expect(mockMarkRunCompleted).toHaveBeenCalledWith(['trade_events', 'claim_events']);
    expect(mockRecordIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: 'CLI' }),
    );
  });

  it('keeps the run when its evidence row cannot be written', async () => {
    mockRecordIngestionRun.mockRejectedValue(new Error('append-only table unavailable'));
    const { worker } = makeWorker(async () => completedResult());

    const run = await worker.runOnce('WORKER');

    expect(run.outcome).toBe('COMPLETED');
    expect(mockMarkRunCompleted).toHaveBeenCalled();
  });

  /**
   * A run capped by `TREASURY_INGEST_MAX_EVENTS` read everything it claims to
   * have read, but did not reach the end of its window. Treating that as a
   * completed run reported a permanently-behind ingester as level with the
   * chain -- the same false-green this control removes, produced by a worker
   * that is running rather than one that stopped.
   */
  it('does not advance freshness when the run stopped short of its window', async () => {
    const { worker } = makeWorker(async () =>
      completedResult({
        windowExhausted: false,
        ingestedThroughBlockNumber: 600,
        nextTradeBlockNumber: 601,
      }),
    );

    const run = await worker.runOnce('WORKER');

    expect(run.outcome).toBe('PARTIAL');
    expect(mockMarkRunCompleted).not.toHaveBeenCalled();
    expect(mockMarkRunPartial).toHaveBeenCalledWith(
      ['trade_events', 'claim_events'],
      expect.stringContaining('600'),
    );
  });

  it('records the coverage a capped run actually reached, not the window it targeted', async () => {
    const { worker } = makeWorker(async () =>
      completedResult({ windowExhausted: false, ingestedThroughBlockNumber: 600 }),
    );

    await worker.runOnce('WORKER');

    expect(mockRecordIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'PARTIAL', ingestedThroughBlockNumber: 600 }),
    );
  });

  /** A capped run is not a failure, so it must not drive the failure alarm. */
  it('does not count a capped run as a failure', async () => {
    const { worker } = makeWorker(async () =>
      completedResult({ windowExhausted: false, ingestedThroughBlockNumber: 600 }),
    );

    await worker.runOnce('WORKER');

    expect(mockMarkRunUnsuccessful).not.toHaveBeenCalled();
  });

  it('stops scheduling once stopped', async () => {
    const ingestOnce = jest.fn(async () => completedResult());
    const { worker } = makeWorker(ingestOnce);

    worker.start();
    await worker.stop();
    const callsAfterStop = ingestOnce.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ingestOnce.mock.calls.length).toBe(callsAfterStop);
  });
});
