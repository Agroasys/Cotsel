const mockGetIngestionWatermark = jest.fn();
const mockSetIngestionWatermark = jest.fn();
const mockUpsertLedgerEntryWithInitialState = jest.fn();
const mockUpsertTreasuryClaimEvent = jest.fn();

jest.mock('../src/database/queries', () => ({
  getIngestionWatermark: mockGetIngestionWatermark,
  setIngestionWatermark: mockSetIngestionWatermark,
  upsertLedgerEntryWithInitialState: mockUpsertLedgerEntryWithInitialState,
  upsertTreasuryClaimEvent: mockUpsertTreasuryClaimEvent,
}));

process.env.PORT = process.env.PORT || '3001';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://localhost:3000/graphql';

// The config module reads these at first import, and TypeScript emits each
// `require` where its import statement sits, so this has to precede them.
import {
  attachIndexer,
  chainReader,
  FINALIZED_BLOCK,
  makeEvent,
  makeService,
} from './helpers/ingestion';

import type { IndexerBlockWindow } from '../src/indexer/client';

/**
 * WP-4 B-08 / FAIL-06: how far ingestion is allowed to read.
 *
 * Two independent upper bounds, and a refusal when either is unknown. The
 * separation matters because each one alone is insufficient: finality keeps
 * reorganizable evidence out, and indexer progress keeps an unindexed range
 * from being mistaken for an empty one.
 */
describe('TreasuryIngestionService read window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIngestionWatermark.mockResolvedValue(0);
    mockSetIngestionWatermark.mockResolvedValue(undefined);
    mockUpsertLedgerEntryWithInitialState.mockResolvedValue({
      entry: { id: 1 },
      initialStateCreated: true,
    });
  });

  it('bounds the read window by the finalized head and resumes from the block watermark', async () => {
    mockGetIngestionWatermark.mockImplementation(async (cursor: string) =>
      cursor === 'trade_events' ? 120 : 0,
    );

    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-1',
          tradeId: 'trade-1',
          eventName: 'FundsReleasedStage1',
          blockNumber: 120,
          releasedLogisticsAmount: '100',
        }),
      ])
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents);

    const result = await service.ingestOnce();

    const window = fetchTreasuryEvents.mock.calls[0][0] as IndexerBlockWindow;
    expect(window.fromBlock).toBe(120);
    expect(window.toBlock).toBe(FINALIZED_BLOCK);
    expect(result.stableBlockNumber).toBe(FINALIZED_BLOCK);
    expect(result.ingestedThroughBlockNumber).toBe(FINALIZED_BLOCK);
    expect(result.blockedReason).toBeNull();
    // The window was exhausted, so the next run starts past the finalized head
    // it was bounded by rather than re-reading it.
    expect(mockSetIngestionWatermark).toHaveBeenNthCalledWith(
      1,
      FINALIZED_BLOCK + 1,
      'trade_events',
      FINALIZED_BLOCK,
    );
  });

  it('refuses to ingest when the settlement RPC reports no finalized head', async () => {
    const fetchTreasuryEvents = jest.fn().mockResolvedValue([]);
    const service = makeService(chainReader({ finalized: null }));
    attachIndexer(service, fetchTreasuryEvents);

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(0);
    expect(result.stableBlockNumber).toBeNull();
    expect(result.blockedReason).toMatch(/finalized head/);
    expect(fetchTreasuryEvents).not.toHaveBeenCalled();
    expect(mockSetIngestionWatermark).not.toHaveBeenCalled();
  });

  it('bounds the window by indexer progress when the indexer lags the finalized head', async () => {
    // The regression: the chain is final through 500 but the indexer has only
    // reached 300. A query bounded by the chain returns a short page for
    // 301-500 because those blocks are simply not indexed yet, and the old code
    // read that as "range consumed" and advanced past them for good.
    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-lag',
          tradeId: 'trade-lag',
          eventName: 'FundsReleasedStage1',
          blockNumber: 300,
          releasedLogisticsAmount: '100',
        }),
      ])
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents, undefined, jest.fn().mockResolvedValue(300));

    const result = await service.ingestOnce();

    expect((fetchTreasuryEvents.mock.calls[0][0] as IndexerBlockWindow).toBlock).toBe(300);
    expect(result.stableBlockNumber).toBe(FINALIZED_BLOCK);
    expect(result.indexerProcessedBlockNumber).toBe(300);
    expect(result.ingestedThroughBlockNumber).toBe(300);
    // Resume at 301, not past the finalized head the indexer never reached.
    expect(result.nextTradeBlockNumber).toBe(301);
    expect(mockSetIngestionWatermark).toHaveBeenNthCalledWith(1, 301, 'trade_events', 300);
  });

  it('refuses to ingest when the indexer cannot report its processed height', async () => {
    const fetchTreasuryEvents = jest.fn().mockResolvedValue([]);
    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents, undefined, jest.fn().mockResolvedValue(null));

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(0);
    expect(result.blockedReason).toMatch(/processed block height/);
    expect(fetchTreasuryEvents).not.toHaveBeenCalled();
    expect(mockSetIngestionWatermark).not.toHaveBeenCalled();
  });

  it('uses the finalized head when the indexer has run ahead of it', async () => {
    const fetchTreasuryEvents = jest.fn().mockResolvedValue([]);
    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents, undefined, jest.fn().mockResolvedValue(9_999_999));

    const result = await service.ingestOnce();

    expect((fetchTreasuryEvents.mock.calls[0][0] as IndexerBlockWindow).toBlock).toBe(
      FINALIZED_BLOCK,
    );
    expect(result.ingestedThroughBlockNumber).toBe(FINALIZED_BLOCK);
  });
});
