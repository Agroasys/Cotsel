import { isAbsentChainTrade, type Trade } from '@agroasys/sdk';
import type {
  CoverageBoundary,
  CoverageSlaVerdict,
  CoverageWindow,
  DriftFinding,
  IndexedTradeRecord,
} from '../types';

/**
 * Complete-range accounting for one run.
 *
 * A run still has a work budget — an unbounded sweep would never finish on a
 * large id space — but the budget no longer truncates silently. Whatever the
 * budget does not reach is reported as `uncoveredTail` and resumed from
 * `nextCursor`, so the exposure is visible rather than hidden behind a cap.
 */
export function planCoverageWindow(input: {
  cursor: bigint;
  chainTradeCounter: bigint;
  budget: number;
}): CoverageWindow {
  if (input.budget <= 0) {
    throw new Error('Coverage budget must be greater than zero');
  }

  const cursor = input.cursor < 0n ? 0n : input.cursor;
  const counter = input.chainTradeCounter;

  if (cursor >= counter) {
    // Nothing new on chain: the covered range is empty but complete.
    return {
      fromTradeId: counter + 1n,
      toTradeId: counter,
      nextCursor: counter,
      uncoveredTail: 0n,
      complete: true,
    };
  }

  const fromTradeId = cursor + 1n;
  const budget = BigInt(input.budget);
  const remaining = counter - cursor;
  const covered = remaining < budget ? remaining : budget;
  const toTradeId = cursor + covered;

  return {
    fromTradeId,
    toTradeId,
    nextCursor: toTradeId,
    uncoveredTail: counter - toTradeId,
    complete: toTradeId === counter,
  };
}

export function tradeIdsInWindow(window: CoverageWindow): string[] {
  const ids: string[] = [];
  for (let id = window.fromTradeId; id <= window.toTradeId; id += 1n) {
    ids.push(id.toString());
  }
  return ids;
}

/** Split a window's ids into request-sized batches. */
export function batchTradeIds(tradeIds: string[], batchSize: number): string[][] {
  if (batchSize <= 0) {
    throw new Error('Batch size must be greater than zero');
  }

  const batches: string[][] = [];
  for (let index = 0; index < tradeIds.length; index += batchSize) {
    batches.push(tradeIds.slice(index, index + batchSize));
  }
  return batches;
}

export interface ChainTradeRecord {
  tradeId: string;
  trade: Trade | null;
  readError?: string;
}

export interface CoverageComparison {
  /** Chain trades the indexer never projected — the B-07/FAIL-05 direction. */
  missingFromIndexer: DriftFinding[];
  /** Ids present on both sides, for field-level classification. */
  paired: Array<{ indexed: IndexedTradeRecord; onchain: Trade | null; readError?: string }>;
  /** Indexed records whose id the chain never allocated. */
  indexerOnly: IndexedTradeRecord[];
  chainTradeCount: number;
}

/**
 * Compare one window in both directions.
 *
 * Chain-derived ids are the authority for what *should* exist. An id the chain
 * holds but the indexer does not is a projection gap; an id the indexer returns
 * that the window never asked for is an indexer-only record.
 */
export function compareCoverage(input: {
  window: CoverageWindow;
  boundary: CoverageBoundary;
  chainTrades: ChainTradeRecord[];
  indexedTrades: IndexedTradeRecord[];
}): CoverageComparison {
  const indexedById = new Map(input.indexedTrades.map((trade) => [trade.tradeId, trade]));
  const requestedIds = new Set(input.chainTrades.map((record) => record.tradeId));

  const missingFromIndexer: DriftFinding[] = [];
  const paired: CoverageComparison['paired'] = [];
  let chainTradeCount = 0;

  for (const record of input.chainTrades) {
    const indexed = indexedById.get(record.tradeId);
    const existsOnChain = record.trade !== null && !isAbsentChainTrade(record.trade);

    if (existsOnChain) {
      chainTradeCount += 1;
    }

    if (indexed) {
      paired.push({
        indexed,
        onchain: record.trade,
        readError: record.readError,
      });
      continue;
    }

    if (record.readError) {
      // Cannot conclude a projection gap while the chain read itself failed.
      missingFromIndexer.push({
        tradeId: record.tradeId,
        severity: 'HIGH',
        mismatchCode: 'ONCHAIN_READ_ERROR',
        comparedField: 'tradePresence',
        onchainValue: null,
        indexedValue: null,
        details: {
          reason: 'chain read failed while checking indexer coverage',
          error: record.readError,
          boundaryBlock: input.boundary.blockNumber,
        },
      });
      continue;
    }

    if (!existsOnChain) {
      // An id below the counter with no chain record is not a projection gap.
      continue;
    }

    missingFromIndexer.push({
      tradeId: record.tradeId,
      severity: 'CRITICAL',
      mismatchCode: 'INDEXER_TRADE_MISSING',
      comparedField: 'tradePresence',
      onchainValue: record.tradeId,
      indexedValue: null,
      details: {
        reason: 'chain trade absent from the indexer projection',
        boundaryBlock: input.boundary.blockNumber,
        boundaryTag: input.boundary.tag,
        impact: 'settlement projection incomplete',
      },
    });
  }

  const indexerOnly = input.indexedTrades.filter((trade) => !requestedIds.has(trade.tradeId));

  return { missingFromIndexer, paired, indexerOnly, chainTradeCount };
}

/**
 * The indexer must never hold more trades than the chain has allocated ids.
 * This catches indexer-only records outside the current window without a
 * lexicographic range scan over the string-typed `tradeId`.
 */
export function checkIndexerSurplus(input: {
  indexerTradeCount: number | null;
  boundary: CoverageBoundary;
}): DriftFinding | null {
  if (input.indexerTradeCount === null) {
    return null;
  }

  const chainCounter = input.boundary.chainTradeCounter;
  if (BigInt(input.indexerTradeCount) <= chainCounter) {
    return null;
  }

  return {
    tradeId: 'coverage',
    severity: 'CRITICAL',
    mismatchCode: 'INDEXER_SURPLUS_RECORDS',
    comparedField: 'tradeCount',
    onchainValue: chainCounter.toString(),
    indexedValue: String(input.indexerTradeCount),
    details: {
      reason: 'indexer holds more trades than the chain has allocated ids',
      boundaryBlock: input.boundary.blockNumber,
      boundaryTag: input.boundary.tag,
    },
  };
}

/**
 * Age SLA over the uncovered tail.
 *
 * A backlog is only a breach once it has persisted: a tail that appeared
 * moments ago is normal throughput, while one that has not shrunk within the
 * SLA means the sweep can no longer keep up and must not be treated as clean.
 */
export function evaluateCoverageSla(input: {
  uncoveredTail: bigint;
  tailFirstSeenAt: Date | null;
  now: Date;
  maxAgeMs: number;
}): CoverageSlaVerdict {
  if (input.uncoveredTail === 0n) {
    return { breached: false, uncoveredTail: 0n, oldestUncoveredAgeMs: null, reason: null };
  }

  if (!input.tailFirstSeenAt) {
    return {
      breached: false,
      uncoveredTail: input.uncoveredTail,
      oldestUncoveredAgeMs: 0,
      reason: null,
    };
  }

  const ageMs = input.now.getTime() - input.tailFirstSeenAt.getTime();
  if (ageMs < input.maxAgeMs) {
    return {
      breached: false,
      uncoveredTail: input.uncoveredTail,
      oldestUncoveredAgeMs: ageMs,
      reason: null,
    };
  }

  return {
    breached: true,
    uncoveredTail: input.uncoveredTail,
    oldestUncoveredAgeMs: ageMs,
    reason: `uncovered tail of ${input.uncoveredTail.toString()} trade(s) has exceeded the ${input.maxAgeMs}ms coverage SLA`,
  };
}
