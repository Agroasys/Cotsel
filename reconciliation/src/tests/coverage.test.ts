import assert from 'node:assert/strict';
import test from 'node:test';
import { TradeStatus, type Trade } from '@agroasys/sdk';
import {
  batchTradeIds,
  checkIndexerSurplus,
  compareCoverage,
  evaluateCoverageSla,
  planCoverageWindow,
  tradeIdsInWindow,
  type ChainTradeRecord,
} from '../core/coverage';
import type { CoverageBoundary, IndexedTradeRecord } from '../types';

const BOUNDARY: CoverageBoundary = {
  blockNumber: 1_000_000,
  blockHash: '0xboundary',
  tag: 'finalized',
  chainTradeCounter: 0n,
};

function boundary(chainTradeCounter: bigint): CoverageBoundary {
  return { ...BOUNDARY, chainTradeCounter };
}

function chainTrade(tradeId: string): Trade {
  return {
    tradeId,
    buyer: '0x1111111111111111111111111111111111111111',
    supplier: '0x2222222222222222222222222222222222222222',
    status: TradeStatus.LOCKED,
    totalAmountLocked: 1_000_000n,
    logisticsAmount: 0n,
    platformFeesAmount: 0n,
    supplierFirstTranche: 600_000n,
    supplierSecondTranche: 400_000n,
    ricardianHash: `0x${'ab'.repeat(32)}`,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };
}

/** The contract returns a zero struct for an id it never allocated. */
function absentChainTrade(tradeId: string): Trade {
  return {
    ...chainTrade(tradeId),
    buyer: '0x0000000000000000000000000000000000000000',
    supplier: '0x0000000000000000000000000000000000000000',
    totalAmountLocked: 0n,
    supplierFirstTranche: 0n,
    supplierSecondTranche: 0n,
    createdAt: new Date(0),
  };
}

function indexedTrade(tradeId: string): IndexedTradeRecord {
  return {
    tradeId,
    buyer: '0x1111111111111111111111111111111111111111',
    supplier: '0x2222222222222222222222222222222222222222',
    status: 'LOCKED',
    totalAmountLocked: 1_000_000n,
    logisticsAmount: 0n,
    platformFeesAmount: 0n,
    platformFeeNetAmount: 0n,
    settlementSupportFeeAmount: 0n,
    supplierFirstTranche: 600_000n,
    supplierSecondTranche: 400_000n,
    ricardianHash: `0x${'ab'.repeat(32)}`,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    arrivalTimestamp: null,
  };
}

test('a window covers the ids after the cursor up to the chain counter', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 5n, budget: 100 });

  assert.equal(window.fromTradeId, 1n);
  assert.equal(window.toTradeId, 5n);
  assert.equal(window.nextCursor, 5n);
  assert.equal(window.uncoveredTail, 0n);
  assert.equal(window.complete, true);
});

test('a run resumes from the persisted cursor rather than re-sweeping', () => {
  const window = planCoverageWindow({ cursor: 1200n, chainTradeCounter: 1500n, budget: 1000 });

  assert.equal(window.fromTradeId, 1201n);
  assert.equal(window.toTradeId, 1500n);
  assert.equal(window.complete, true);
});

test('the budget bounds the window but reports the tail instead of hiding it', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 2500n, budget: 1000 });

  assert.equal(window.toTradeId, 1000n);
  assert.equal(window.nextCursor, 1000n);
  // The exposure a fixed cap used to leave silently unreconciled.
  assert.equal(window.uncoveredTail, 1500n);
  assert.equal(window.complete, false);
});

test('a caught-up sweep produces an empty but complete window', () => {
  const window = planCoverageWindow({ cursor: 42n, chainTradeCounter: 42n, budget: 1000 });

  assert.equal(window.uncoveredTail, 0n);
  assert.equal(window.complete, true);
  assert.deepEqual(tradeIdsInWindow(window), []);
});

test('a cursor ahead of the counter cannot produce a negative window', () => {
  const window = planCoverageWindow({ cursor: 50n, chainTradeCounter: 10n, budget: 1000 });

  assert.equal(window.uncoveredTail, 0n);
  assert.equal(window.complete, true);
  assert.deepEqual(tradeIdsInWindow(window), []);
});

test('a non-positive budget is rejected rather than silently covering nothing', () => {
  assert.throws(
    () => planCoverageWindow({ cursor: 0n, chainTradeCounter: 10n, budget: 0 }),
    /budget must be greater than zero/,
  );
});

test('window ids are enumerated inclusively and batched for request limits', () => {
  const window = planCoverageWindow({ cursor: 3n, chainTradeCounter: 9n, budget: 1000 });

  assert.deepEqual(tradeIdsInWindow(window), ['4', '5', '6', '7', '8', '9']);
  assert.deepEqual(batchTradeIds(tradeIdsInWindow(window), 4), [
    ['4', '5', '6', '7'],
    ['8', '9'],
  ]);
});

test('a chain trade the indexer never projected is a critical coverage gap', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 2n, budget: 10 });
  const chainTrades: ChainTradeRecord[] = [
    { tradeId: '1', trade: chainTrade('1') },
    { tradeId: '2', trade: chainTrade('2') },
  ];

  const comparison = compareCoverage({
    window,
    boundary: boundary(2n),
    chainTrades,
    indexedTrades: [indexedTrade('1')],
  });

  assert.equal(comparison.missingFromIndexer.length, 1);
  const [finding] = comparison.missingFromIndexer;
  assert.equal(finding.tradeId, '2');
  assert.equal(finding.mismatchCode, 'INDEXER_TRADE_MISSING');
  assert.equal(finding.severity, 'CRITICAL');
  assert.equal(finding.details.boundaryBlock, BOUNDARY.blockNumber);
  assert.equal(comparison.paired.length, 1);
  assert.equal(comparison.chainTradeCount, 2);
});

test('an id the chain never allocated is not reported as a projection gap', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 2n, budget: 10 });

  const comparison = compareCoverage({
    window,
    boundary: boundary(2n),
    chainTrades: [
      { tradeId: '1', trade: chainTrade('1') },
      { tradeId: '2', trade: absentChainTrade('2') },
    ],
    indexedTrades: [indexedTrade('1')],
  });

  assert.deepEqual(comparison.missingFromIndexer, []);
  assert.equal(comparison.chainTradeCount, 1);
});

test('a failed chain read is reported as a read error, never as a coverage gap', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 1n, budget: 10 });

  const comparison = compareCoverage({
    window,
    boundary: boundary(1n),
    chainTrades: [{ tradeId: '1', trade: null, readError: 'rpc timeout' }],
    indexedTrades: [],
  });

  assert.equal(comparison.missingFromIndexer.length, 1);
  assert.equal(comparison.missingFromIndexer[0].mismatchCode, 'ONCHAIN_READ_ERROR');
  assert.equal(comparison.missingFromIndexer[0].severity, 'HIGH');
});

test('an indexed record outside the chain-derived id window is indexer-only', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 1n, budget: 10 });

  const comparison = compareCoverage({
    window,
    boundary: boundary(1n),
    chainTrades: [{ tradeId: '1', trade: chainTrade('1') }],
    indexedTrades: [indexedTrade('1'), indexedTrade('99')],
  });

  assert.deepEqual(
    comparison.indexerOnly.map((trade) => trade.tradeId),
    ['99'],
  );
});

test('the indexer may not hold more trades than the chain allocated ids', () => {
  assert.equal(checkIndexerSurplus({ indexerTradeCount: 10, boundary: boundary(10n) }), null);
  assert.equal(checkIndexerSurplus({ indexerTradeCount: null, boundary: boundary(10n) }), null);

  const surplus = checkIndexerSurplus({ indexerTradeCount: 11, boundary: boundary(10n) });
  assert.ok(surplus);
  assert.equal(surplus.mismatchCode, 'INDEXER_SURPLUS_RECORDS');
  assert.equal(surplus.severity, 'CRITICAL');
  assert.equal(surplus.onchainValue, '10');
  assert.equal(surplus.indexedValue, '11');
});

test('no tail means no SLA breach', () => {
  const verdict = evaluateCoverageSla({
    uncoveredTail: 0n,
    tailFirstSeenAt: new Date('2026-09-01T00:00:00Z'),
    now: new Date('2026-09-09T00:00:00Z'),
    maxAgeMs: 1000,
  });

  assert.equal(verdict.breached, false);
  assert.equal(verdict.oldestUncoveredAgeMs, null);
});

test('a tail within the SLA is normal throughput, not a breach', () => {
  const verdict = evaluateCoverageSla({
    uncoveredTail: 500n,
    tailFirstSeenAt: new Date('2026-09-09T00:00:00Z'),
    now: new Date('2026-09-09T00:00:30Z'),
    maxAgeMs: 3_600_000,
  });

  assert.equal(verdict.breached, false);
  assert.equal(verdict.oldestUncoveredAgeMs, 30_000);
});

test('a tail that has not shrunk within the SLA is a breach', () => {
  const verdict = evaluateCoverageSla({
    uncoveredTail: 500n,
    tailFirstSeenAt: new Date('2026-09-09T00:00:00Z'),
    now: new Date('2026-09-09T02:00:00Z'),
    maxAgeMs: 3_600_000,
  });

  assert.equal(verdict.breached, true);
  assert.equal(verdict.uncoveredTail, 500n);
  assert.match(verdict.reason ?? '', /coverage SLA/);
});

test('a tail seen for the first time starts the SLA clock without breaching', () => {
  const verdict = evaluateCoverageSla({
    uncoveredTail: 10n,
    tailFirstSeenAt: null,
    now: new Date('2026-09-09T00:00:00Z'),
    maxAgeMs: 1,
  });

  assert.equal(verdict.breached, false);
  assert.equal(verdict.oldestUncoveredAgeMs, 0);
});
