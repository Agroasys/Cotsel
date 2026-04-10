const mockGetIngestionOffset = jest.fn();
const mockSetIngestionOffset = jest.fn();
const mockUpsertLedgerEntryWithInitialState = jest.fn();

jest.mock('../src/database/queries', () => ({
  getIngestionOffset: mockGetIngestionOffset,
  setIngestionOffset: mockSetIngestionOffset,
  upsertLedgerEntryWithInitialState: mockUpsertLedgerEntryWithInitialState,
}));

process.env.PORT = process.env.PORT || '3001';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://localhost:3000/graphql';

import { TreasuryIngestionService } from '../src/core/ingestion';
import { IndexerTradeEvent } from '../src/types';

function makeEvent(
  data: Partial<IndexerTradeEvent> & Pick<IndexerTradeEvent, 'id' | 'tradeId' | 'eventName'>,
): IndexerTradeEvent {
  return {
    id: data.id,
    tradeId: data.tradeId,
    eventName: data.eventName,
    txHash: data.txHash === undefined ? '0xtx' : data.txHash,
    blockNumber: data.blockNumber ?? 1,
    timestamp: data.timestamp || new Date('2026-01-01T00:00:00.000Z'),
    releasedLogisticsAmount: data.releasedLogisticsAmount,
    paidPlatformFees: data.paidPlatformFees,
  };
}

describe('TreasuryIngestionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists and reuses ingestion cursor between runs', async () => {
    const service = new TreasuryIngestionService();
    const events: IndexerTradeEvent[] = [
      makeEvent({
        id: 'evt-1',
        tradeId: 'trade-1',
        eventName: 'FundsReleasedStage1',
        releasedLogisticsAmount: '100',
      }),
      makeEvent({
        id: 'evt-2',
        tradeId: 'trade-1',
        eventName: 'PlatformFeesPaidStage1',
        paidPlatformFees: '10',
      }),
      makeEvent({
        id: 'evt-3',
        tradeId: 'trade-2',
        eventName: 'FundsReleasedStage1',
        releasedLogisticsAmount: '200',
      }),
    ];

    let persistedOffset = 0;
    mockGetIngestionOffset.mockImplementation(async () => persistedOffset);
    mockSetIngestionOffset.mockImplementation(async (nextOffset: number) => {
      persistedOffset = nextOffset;
    });
    mockUpsertLedgerEntryWithInitialState.mockResolvedValue({
      entry: { id: 1 },
      initialStateCreated: true,
    });

    const fetchTreasuryEvents = jest.fn(async (_limit: number, offset: number) => {
      return events.slice(offset);
    });

    (
      service as unknown as { indexerClient: { fetchTreasuryEvents: typeof fetchTreasuryEvents } }
    ).indexerClient = {
      fetchTreasuryEvents,
    };

    const firstRun = await service.ingestOnce();

    expect(firstRun).toEqual({ fetched: 3, inserted: 3 });
    expect(fetchTreasuryEvents.mock.calls[0][1]).toBe(0);
    expect(mockSetIngestionOffset).toHaveBeenLastCalledWith(3);
    expect(persistedOffset).toBe(3);

    fetchTreasuryEvents.mockClear();
    mockUpsertLedgerEntryWithInitialState.mockClear();

    const secondRun = await service.ingestOnce();

    expect(secondRun).toEqual({ fetched: 0, inserted: 0 });
    expect(fetchTreasuryEvents.mock.calls[0][1]).toBe(3);
    expect(mockUpsertLedgerEntryWithInitialState).not.toHaveBeenCalled();
  });

  it('counts inserted entries only when initial lifecycle state is created', async () => {
    const service = new TreasuryIngestionService();

    mockGetIngestionOffset.mockResolvedValue(0);
    mockSetIngestionOffset.mockResolvedValue(undefined);
    mockUpsertLedgerEntryWithInitialState
      .mockResolvedValueOnce({ entry: { id: 1 }, initialStateCreated: true })
      .mockResolvedValueOnce({ entry: { id: 1 }, initialStateCreated: false });

    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-a',
          tradeId: 'trade-a',
          eventName: 'FundsReleasedStage1',
          releasedLogisticsAmount: '500',
        }),
        makeEvent({
          id: 'evt-b',
          tradeId: 'trade-a',
          eventName: 'PlatformFeesPaidStage1',
          paidPlatformFees: '50',
        }),
      ])
      .mockResolvedValueOnce([]);

    (
      service as unknown as { indexerClient: { fetchTreasuryEvents: typeof fetchTreasuryEvents } }
    ).indexerClient = {
      fetchTreasuryEvents,
    };

    const result = await service.ingestOnce();

    expect(result).toEqual({ fetched: 2, inserted: 1 });
    expect(mockSetIngestionOffset).toHaveBeenCalledWith(2);
  });

  it('skips entries when txHash is unavailable and does not attempt DB upsert', async () => {
    const service = new TreasuryIngestionService();

    mockGetIngestionOffset.mockResolvedValue(0);
    mockSetIngestionOffset.mockResolvedValue(undefined);

    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-missing-hash',
          tradeId: 'trade-z',
          eventName: 'FundsReleasedStage1',
          txHash: null,
          releasedLogisticsAmount: '90',
        }),
      ])
      .mockResolvedValueOnce([]);

    (
      service as unknown as { indexerClient: { fetchTreasuryEvents: typeof fetchTreasuryEvents } }
    ).indexerClient = {
      fetchTreasuryEvents,
    };

    const result = await service.ingestOnce();

    expect(result).toEqual({ fetched: 1, inserted: 0 });
    expect(mockUpsertLedgerEntryWithInitialState).not.toHaveBeenCalled();
    expect(mockSetIngestionOffset).toHaveBeenCalledWith(1);
  });

  it('ignores non-treasury events so principal never enters treasury ingestion', async () => {
    const service = new TreasuryIngestionService();

    mockGetIngestionOffset.mockResolvedValue(0);
    mockSetIngestionOffset.mockResolvedValue(undefined);

    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-final-tranche',
          tradeId: 'trade-principal',
          eventName: 'FinalTrancheReleased',
        }),
      ])
      .mockResolvedValueOnce([]);

    (
      service as unknown as { indexerClient: { fetchTreasuryEvents: typeof fetchTreasuryEvents } }
    ).indexerClient = {
      fetchTreasuryEvents,
    };

    const result = await service.ingestOnce();

    expect(result).toEqual({ fetched: 1, inserted: 0 });
    expect(mockUpsertLedgerEntryWithInitialState).not.toHaveBeenCalled();
    expect(mockSetIngestionOffset).toHaveBeenCalledWith(1);
  });

  it('does not double-count replayed treasury events with the same canonical event id', async () => {
    const service = new TreasuryIngestionService();

    mockGetIngestionOffset.mockResolvedValue(0);
    mockSetIngestionOffset.mockResolvedValue(undefined);
    mockUpsertLedgerEntryWithInitialState
      .mockResolvedValueOnce({ entry: { id: 1 }, initialStateCreated: true })
      .mockResolvedValueOnce({ entry: { id: 1 }, initialStateCreated: false });

    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-replay',
          tradeId: 'trade-replay',
          eventName: 'PlatformFeesPaidStage1',
          paidPlatformFees: '15',
        }),
        makeEvent({
          id: 'evt-replay',
          tradeId: 'trade-replay',
          eventName: 'PlatformFeesPaidStage1',
          paidPlatformFees: '15',
        }),
      ])
      .mockResolvedValueOnce([]);

    (
      service as unknown as { indexerClient: { fetchTreasuryEvents: typeof fetchTreasuryEvents } }
    ).indexerClient = {
      fetchTreasuryEvents,
    };

    const result = await service.ingestOnce();

    expect(result).toEqual({ fetched: 2, inserted: 1 });
    expect(mockUpsertLedgerEntryWithInitialState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ entryKey: 'evt-replay:platform_fee' }),
    );
    expect(mockUpsertLedgerEntryWithInitialState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ entryKey: 'evt-replay:platform_fee' }),
    );
  });
});
