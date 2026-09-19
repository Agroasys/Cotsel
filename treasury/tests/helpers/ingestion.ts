/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared fixtures for the ingestion suites. Ingestion has two distinct
 * concerns -- what it accepts from the chain, and how far it is allowed to read
 * -- which are tested separately; both need the same stand-in chain and
 * indexer.
 */
import { ChainCanonicalityVerifier } from '../../src/core/chainCanonicality';
import type { SettlementChainReader } from '../../src/core/chainCanonicality';
import { TreasuryIngestionService } from '../../src/core/ingestion';
import type { IndexerTradeEvent } from '../../src/indexer/types';

export const FINALIZED_BLOCK = 500;
export const INDEXER_PROCESSED_BLOCK = 10_000;
export const LOG_ADDRESS = `0x${'11'.repeat(20)}`;
export const LOG_TOPIC = `0x${'ee'.repeat(32)}`;

export function blockHashFor(blockNumber: number): string {
  return `0x${blockNumber.toString(16).padStart(64, '0')}`;
}

/**
 * A chain that answers for every height. `finalized` is what bounds ingestion,
 * so a test that wants an unbounded run has to say so explicitly.
 */
export function chainReader(options?: {
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
    async getTransactionReceipt(txHash) {
      return {
        blockNumber: 0,
        blockHash: blockHashFor(0),
        status: 1,
        logs: [{ index: 0, address: LOG_ADDRESS, topics: [LOG_TOPIC], data: txHash }],
      };
    },
  };
}

export function makeService(reader: SettlementChainReader): TreasuryIngestionService {
  return new TreasuryIngestionService({
    verifier: new ChainCanonicalityVerifier({ provider: reader }),
  });
}

export function makeEvent(
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

export function attachIndexer(
  service: TreasuryIngestionService,
  fetchTreasuryEvents: jest.Mock,
  fetchTreasuryClaimEvents: jest.Mock = jest.fn().mockResolvedValue([]),
  fetchProcessedBlock: jest.Mock = jest.fn().mockResolvedValue(INDEXER_PROCESSED_BLOCK),
): void {
  (
    service as unknown as {
      indexerClient: {
        fetchTreasuryEvents: jest.Mock;
        fetchTreasuryClaimEvents: jest.Mock;
        fetchProcessedBlock: jest.Mock;
      };
    }
  ).indexerClient = { fetchTreasuryEvents, fetchTreasuryClaimEvents, fetchProcessedBlock };
}
