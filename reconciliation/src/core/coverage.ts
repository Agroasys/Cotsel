import { isAbsentChainTrade, type Trade } from '@agroasys/sdk';
import type {
  CoverageBoundary,
  CoverageSlaVerdict,
  CoverageWindow,
  DriftCode,
  DriftFinding,
  IndexedTradeRecord,
} from '../types';

/**
 * Findings that prove a range has not been reconciled and therefore must hold
 * the cursor in place. Advancing past any of these would retire the evidence
 * and let the next run report the range clean:
 *
 * - `INDEXER_TRADE_MISSING` / `INDEXER_SURPLUS_RECORDS` — a real projection gap.
 * - `ONCHAIN_TRADE_MISSING` — the indexer holds an id the chain never allocated.
 * - `ONCHAIN_READ_ERROR` — the chain read was inconclusive, so neither presence
 *   nor drift could be decided. A transient RPC failure must never let a window
 *   advance and permanently retire the ids it could not check.
 */
const CURSOR_HOLDING_CODES: ReadonlySet<DriftCode> = new Set<DriftCode>([
  'INDEXER_TRADE_MISSING',
  'INDEXER_SURPLUS_RECORDS',
  'ONCHAIN_TRADE_MISSING',
  'ONCHAIN_READ_ERROR',
]);

export function holdsCursor(code: DriftCode): boolean {
  return CURSOR_HOLDING_CODES.has(code);
}

/**
 * Resolve the single block a run pins every read to.
 *
 * The chain can be read at any historical block, but the indexer only reports
 * its *current* projection, so the one height both sides can describe is the
 * block the indexer has actually processed. Anchoring the chain reads there —
 * rather than at a finalized head the indexer may not have reached, or may have
 * run past — is what keeps a field difference or a surplus real instead of an
 * artefact of the two sides sitting at different heights.
 *
 * `indexerAhead` flags the case the chain boundary preference cannot protect
 * against on its own: an indexer configured with a shallower finality than the
 * run's boundary tag, processing closer to head than the finalized block.
 */
export function anchorBoundaryBlock(input: {
  finalityBlockNumber: number;
  indexerProcessedBlock: number;
}): { blockNumber: number; indexerAhead: boolean } {
  return {
    blockNumber: input.indexerProcessedBlock,
    indexerAhead: input.indexerProcessedBlock > input.finalityBlockNumber,
  };
}

/**
 * Where the next run resumes from.
 *
 * A held gap freezes the cursor at its previous value. Otherwise, a run that
 * reached the chain counter has completed a full sweep and resets to 0 to begin
 * a fresh epoch — without this, once the cursor reaches `tradeCounter` every
 * later run plans an empty window and existing trades are never re-reconciled.
 * A budget-bounded run advances to the end of its window.
 */
export function planNextCursor(input: {
  window: CoverageWindow;
  cursorHeld: boolean;
  previousCursor: bigint;
}): bigint {
  if (input.cursorHeld) {
    return input.previousCursor;
  }
  return input.window.complete ? 0n : input.window.nextCursor;
}

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
 * Independent indexer-side enumeration.
 *
 * `fetchTradesByIds` can only return ids from its own `tradeId_in` filter, so
 * it can never surface a record the chain never allocated, and a raw count can
 * hide a surplus id when a separately-missing expected id cancels it out. This
 * walks the indexer's own id set and reports every id that is not a
 * chain-allocated trade (`> tradeCounter`, or non-positive), proving the
 * indexer-only direction directly rather than by counting.
 */
export function detectIndexerOnlyTradeIds(input: {
  indexerTradeIds: string[];
  boundary: CoverageBoundary;
}): DriftFinding[] {
  const counter = input.boundary.chainTradeCounter;
  const findings: DriftFinding[] = [];

  for (const rawId of input.indexerTradeIds) {
    let numericId: bigint;
    try {
      numericId = BigInt(rawId);
    } catch {
      // A non-numeric id is itself an id the sequential chain never allocated.
      findings.push(indexerOnlyFinding(rawId, input.boundary, 'indexer trade id is not numeric'));
      continue;
    }

    if (numericId <= 0n || numericId > counter) {
      findings.push(
        indexerOnlyFinding(
          rawId,
          input.boundary,
          'indexer holds a trade id the chain never allocated',
        ),
      );
    }
  }

  return findings;
}

function indexerOnlyFinding(
  tradeId: string,
  boundary: CoverageBoundary,
  reason: string,
): DriftFinding {
  return {
    tradeId,
    severity: 'CRITICAL',
    mismatchCode: 'ONCHAIN_TRADE_MISSING',
    comparedField: 'tradePresence',
    onchainValue: null,
    indexedValue: tradeId,
    details: {
      reason,
      chainTradeCounter: boundary.chainTradeCounter.toString(),
      boundaryBlock: boundary.blockNumber,
      boundaryTag: boundary.tag,
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
