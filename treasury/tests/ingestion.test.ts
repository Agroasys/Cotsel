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

import { TreasuryIngestionService } from '../src/core/ingestion';
import {
  ChainCanonicalityVerifier,
  type SettlementChainReader,
} from '../src/core/chainCanonicality';
import type { IndexerBlockWindow } from '../src/indexer/client';
import type { IndexerTradeEvent } from '../src/indexer/types';

const FINALIZED_BLOCK = 500;

function blockHashFor(blockNumber: number): string {
  return `0x${blockNumber.toString(16).padStart(64, '0')}`;
}

/**
 * A chain that answers for every height. `finalized` is what bounds ingestion,
 * so a test that wants an unbounded run has to say so explicitly.
 */
function chainReader(options?: {
  finalized?: number | null;
  unknownBlocks?: number[];
}): SettlementChainReader {
  const finalized = options?.finalized === undefined ? FINALIZED_BLOCK : options.finalized;
  const unknown = new Set(options?.unknownBlocks ?? []);

  return {
    async getBlock(tag) {
      if (tag === 'finalized') {
        return finalized === null ? null : { number: finalized, hash: blockHashFor(finalized) };
      }
      if (tag === 'safe' || tag === 'latest') {
        return { number: FINALIZED_BLOCK, hash: blockHashFor(FINALIZED_BLOCK) };
      }
      return unknown.has(tag) ? null : { number: tag, hash: blockHashFor(tag) };
    },
    async getTransactionReceipt() {
      return null;
    },
  };
}

function makeService(reader: SettlementChainReader): TreasuryIngestionService {
  return new TreasuryIngestionService({
    verifier: new ChainCanonicalityVerifier({ provider: reader }),
  });
}

function makeEvent(
  data: Partial<IndexerTradeEvent> & Pick<IndexerTradeEvent, 'id' | 'tradeId' | 'eventName'>,
): IndexerTradeEvent {
  return {
    id: data.id,
    tradeId: data.tradeId,
    eventName: data.eventName,
    txHash: data.txHash === undefined ? '0xtx' : data.txHash,
    blockNumber: data.blockNumber ?? 1,
    logIndex: data.logIndex ?? 0,
    timestamp: data.timestamp || new Date('2026-01-01T00:00:00.000Z'),
    releasedLogisticsAmount: data.releasedLogisticsAmount,
    paidPlatformFees: data.paidPlatformFees,
    paidPlatformFeeNet: data.paidPlatformFeeNet,
    paidSettlementSupportFee: data.paidSettlementSupportFee,
  };
}

function attachIndexer(
  service: TreasuryIngestionService,
  fetchTreasuryEvents: jest.Mock,
  fetchTreasuryClaimEvents: jest.Mock = jest.fn().mockResolvedValue([]),
): void {
  (
    service as unknown as {
      indexerClient: {
        fetchTreasuryEvents: jest.Mock;
        fetchTreasuryClaimEvents: jest.Mock;
      };
    }
  ).indexerClient = { fetchTreasuryEvents, fetchTreasuryClaimEvents };
}

describe('TreasuryIngestionService', () => {
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

  it('records the canonical block hash and log index with every ledger entry', async () => {
    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-fee',
          tradeId: 'trade-fee',
          eventName: 'PlatformFeesPaidStage1',
          blockNumber: 210,
          logIndex: 7,
          paidPlatformFees: '5000000',
        }),
      ])
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents);

    await service.ingestOnce();

    expect(mockUpsertLedgerEntryWithInitialState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        entryKey: 'evt-fee:platform_fee',
        blockNumber: 210,
        blockHash: blockHashFor(210),
        logIndex: 7,
      }),
    );
  });

  it('stops at the block whose canonical hash the chain cannot supply', async () => {
    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-known',
          tradeId: 'trade-known',
          eventName: 'FundsReleasedStage1',
          blockNumber: 300,
          releasedLogisticsAmount: '10',
        }),
        makeEvent({
          id: 'evt-unknown',
          tradeId: 'trade-unknown',
          eventName: 'FundsReleasedStage1',
          blockNumber: 301,
          releasedLogisticsAmount: '20',
        }),
      ])
      .mockResolvedValue([]);

    const service = makeService(chainReader({ unknownBlocks: [301] }));
    attachIndexer(service, fetchTreasuryEvents);

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(1);
    expect(mockUpsertLedgerEntryWithInitialState).toHaveBeenCalledTimes(1);
    // Resume at the unresolvable block, never past it.
    expect(result.nextTradeBlockNumber).toBe(301);
    expect(mockSetIngestionWatermark).toHaveBeenNthCalledWith(1, 301, 'trade_events', 500);
  });

  it('counts inserted entries only when an initial lifecycle state is created', async () => {
    mockUpsertLedgerEntryWithInitialState
      .mockReset()
      .mockResolvedValueOnce({ entry: { id: 1 }, initialStateCreated: true })
      .mockResolvedValueOnce({ entry: { id: 2 }, initialStateCreated: false })
      .mockResolvedValueOnce({ entry: { id: 3 }, initialStateCreated: true });

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
          paidPlatformFees: '5000000',
        }),
      ])
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents);

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(mockUpsertLedgerEntryWithInitialState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        entryKey: 'evt-b:platform_fee',
        componentType: 'PLATFORM_FEE',
        amountRaw: '1000000',
      }),
    );
    expect(mockUpsertLedgerEntryWithInitialState).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        entryKey: 'evt-b:settlement_support_fee',
        componentType: 'SETTLEMENT_SUPPORT_FEE',
        amountRaw: '4000000',
      }),
    );
  });

  it('skips entries when txHash is unavailable and does not attempt a DB upsert', async () => {
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
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents);

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(0);
    expect(mockUpsertLedgerEntryWithInitialState).not.toHaveBeenCalled();
  });

  it('ignores non-treasury events so principal never enters treasury ingestion', async () => {
    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([
        makeEvent({
          id: 'evt-final-tranche',
          tradeId: 'trade-principal',
          eventName: 'FinalTrancheReleased',
        }),
      ])
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents);

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(0);
    expect(mockUpsertLedgerEntryWithInitialState).not.toHaveBeenCalled();
  });

  it('does not double-count replayed treasury events with the same canonical event id', async () => {
    mockUpsertLedgerEntryWithInitialState
      .mockReset()
      .mockResolvedValueOnce({ entry: { id: 1 }, initialStateCreated: true })
      .mockResolvedValueOnce({ entry: { id: 2 }, initialStateCreated: true })
      .mockResolvedValueOnce({ entry: { id: 1 }, initialStateCreated: false })
      .mockResolvedValueOnce({ entry: { id: 2 }, initialStateCreated: false });

    const replay = makeEvent({
      id: 'evt-replay',
      tradeId: 'trade-replay',
      eventName: 'PlatformFeesPaidStage1',
      paidPlatformFees: '5000000',
    });
    const fetchTreasuryEvents = jest
      .fn()
      .mockResolvedValueOnce([replay, replay])
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, fetchTreasuryEvents);

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(mockUpsertLedgerEntryWithInitialState).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ entryKey: 'evt-replay:platform_fee' }),
    );
  });

  it('persists treasury claim events on their own block watermark', async () => {
    mockGetIngestionWatermark.mockImplementation(async (cursor: string) =>
      cursor === 'claim_events' ? 40 : 0,
    );
    mockUpsertTreasuryClaimEvent.mockResolvedValue({
      id: 1,
      matched_sweep_batch_id: null,
      tx_hash: '0xclaim-1',
    });

    const fetchTreasuryClaimEvents = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'claim-1',
          eventName: 'TreasuryClaimed' as const,
          txHash: '0xclaim-1',
          blockNumber: 44,
          logIndex: 2,
          timestamp: new Date('2026-01-01T01:00:00.000Z'),
          claimAmount: '150',
          treasuryIdentity: '0xtreasury',
          payoutReceiver: '0xpayout',
          triggeredBy: '0xoperator',
        },
      ])
      .mockResolvedValue([]);

    const service = makeService(chainReader());
    attachIndexer(service, jest.fn().mockResolvedValue([]), fetchTreasuryClaimEvents);

    const result = await service.ingestOnce();

    expect(result.fetched).toBe(1);
    expect((fetchTreasuryClaimEvents.mock.calls[0][0] as IndexerBlockWindow).fromBlock).toBe(40);
    expect(mockUpsertTreasuryClaimEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventId: 'claim-1',
        matchedSweepBatchId: null,
        txHash: '0xclaim-1',
        amountRaw: '150',
      }),
    );
    expect(mockSetIngestionWatermark).toHaveBeenNthCalledWith(
      2,
      FINALIZED_BLOCK + 1,
      'claim_events',
      FINALIZED_BLOCK,
    );
  });
});
