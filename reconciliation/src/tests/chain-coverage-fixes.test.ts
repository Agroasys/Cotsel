import assert from 'node:assert/strict';
import test from 'node:test';
import { TradeStatus, type Trade } from '@agroasys/sdk';
import {
  anchorBoundaryBlock,
  compareCoverage,
  detectIndexerOnlyTradeIds,
  holdsCursor,
  planCoverageWindow,
  planNextCursor,
  tradeIdsInWindow,
  type ChainTradeRecord,
} from '../core/coverage';
import { classifyDrifts } from '../core/classifier';
import type { CoverageBoundary, IndexedTradeRecord } from '../types';

function boundary(chainTradeCounter: bigint): CoverageBoundary {
  return {
    blockNumber: 1_000_000,
    blockHash: '0xboundary',
    tag: 'finalized',
    chainTradeCounter,
    indexerProcessedBlock: 1_000_000,
    finalityBlockNumber: 1_000_000,
    indexerAhead: false,
  };
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

// ---------------------------------------------------------------------------
// Issue 2: anchor both sides to the same processed block.
// ---------------------------------------------------------------------------

test('the boundary anchors to the indexer block when the indexer trails finality', () => {
  const anchor = anchorBoundaryBlock({ finalityBlockNumber: 1000, indexerProcessedBlock: 940 });

  // Read the chain where the indexer actually is, not at a finalized head it
  // has not reached — otherwise finalized-but-unindexed trades read as gaps.
  assert.equal(anchor.blockNumber, 940);
  assert.equal(anchor.indexerAhead, false);
});

test('an indexer ahead of finality still anchors to the indexer block and is flagged', () => {
  // FINALITY_CONFIRMATION_BLOCKS=1: the indexer processes close to head, ahead
  // of the finalized boundary. Reading the chain at finality while the indexer
  // is ahead would manufacture field drift and a surplus that do not exist.
  const anchor = anchorBoundaryBlock({ finalityBlockNumber: 950, indexerProcessedBlock: 999 });

  assert.equal(anchor.blockNumber, 999);
  assert.equal(anchor.indexerAhead, true);
});

// ---------------------------------------------------------------------------
// Issue 3: hold the cursor on every inconclusive chain read.
// ---------------------------------------------------------------------------

test('inconclusive and gap findings hold the cursor; resolved drift does not', () => {
  for (const code of [
    'INDEXER_TRADE_MISSING',
    'INDEXER_SURPLUS_RECORDS',
    'ONCHAIN_TRADE_MISSING',
    'ONCHAIN_READ_ERROR',
  ] as const) {
    assert.equal(holdsCursor(code), true, `${code} must hold the cursor`);
  }

  for (const code of ['STATUS_MISMATCH', 'AMOUNT_MISMATCH', 'HASH_MISMATCH'] as const) {
    assert.equal(holdsCursor(code), false, `${code} must not hold the cursor`);
  }
});

test('a read error on an indexer-absent id is an inconclusive read that holds the cursor', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 1n, budget: 10 });
  const comparison = compareCoverage({
    window,
    boundary: boundary(1n),
    chainTrades: [{ tradeId: '1', trade: null, readError: 'rpc timeout' }],
    indexedTrades: [],
  });

  assert.equal(comparison.missingFromIndexer.length, 1);
  const [finding] = comparison.missingFromIndexer;
  assert.equal(finding.mismatchCode, 'ONCHAIN_READ_ERROR');
  assert.equal(holdsCursor(finding.mismatchCode), true);
});

test('a read error on an indexer-present id is an inconclusive read that holds the cursor', () => {
  // The id is paired (the indexer has it), so the read error surfaces through
  // the field classifier rather than the coverage comparison. It must still
  // hold: a transient RPC failure cannot retire an id as reconciled.
  const findings = classifyDrifts({
    indexedTrade: indexedTrade('1'),
    onchainTrade: null,
    onchainReadError: 'rpc timeout',
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].mismatchCode, 'ONCHAIN_READ_ERROR');
  assert.equal(holdsCursor(findings[0].mismatchCode), true);
});

// ---------------------------------------------------------------------------
// Issue 1: a completed sweep resets to a fresh epoch so old ids are revisited.
// ---------------------------------------------------------------------------

test('a completed sweep resets the cursor to zero to begin a fresh epoch', () => {
  const window = planCoverageWindow({ cursor: 900n, chainTradeCounter: 1000n, budget: 1000 });
  assert.equal(window.complete, true);

  assert.equal(planNextCursor({ window, cursorHeld: false, previousCursor: 900n }), 0n);
});

test('a budget-bounded sweep advances to the end of its window', () => {
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 2500n, budget: 1000 });
  assert.equal(window.complete, false);

  assert.equal(planNextCursor({ window, cursorHeld: false, previousCursor: 0n }), 1000n);
});

test('a held window freezes the cursor at its previous value', () => {
  const window = planCoverageWindow({ cursor: 500n, chainTradeCounter: 1000n, budget: 1000 });

  assert.equal(planNextCursor({ window, cursorHeld: true, previousCursor: 500n }), 500n);
});

test('a later cycle revisits old ids after a caught-up sweep completes', () => {
  const counter = 5n;
  const budget = 1000;
  const seenByCycle: string[][] = [];
  let cursor = 0n;

  // Three daemon cycles. Without the epoch reset, cycle 2 onward would plan an
  // empty window forever and never re-check an existing trade.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const window = planCoverageWindow({ cursor, chainTradeCounter: counter, budget });
    seenByCycle.push(tradeIdsInWindow(window));
    cursor = planNextCursor({ window, cursorHeld: false, previousCursor: cursor });
  }

  assert.deepEqual(seenByCycle[0], ['1', '2', '3', '4', '5']);
  // Epoch rolled over: the cursor reset to 0 and the next cycle swept the range
  // again rather than stalling on an empty window.
  assert.deepEqual(seenByCycle[1], ['1', '2', '3', '4', '5']);
  assert.deepEqual(seenByCycle[2], ['1', '2', '3', '4', '5']);
});

// ---------------------------------------------------------------------------
// Issue 4: independent indexer-side enumeration proves the indexer-only case.
// ---------------------------------------------------------------------------

test('an indexer id beyond the chain counter is detected by enumeration', () => {
  const findings = detectIndexerOnlyTradeIds({
    indexerTradeIds: ['1', '2', '3', '9999'],
    boundary: boundary(3n),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].tradeId, '9999');
  assert.equal(findings[0].mismatchCode, 'ONCHAIN_TRADE_MISSING');
  assert.equal(findings[0].severity, 'CRITICAL');
  assert.equal(holdsCursor(findings[0].mismatchCode), true);
});

test('enumeration catches a surplus id even when a missing id cancels the raw count', () => {
  // Counter is 3, indexer holds ids 1, 2 and 9999 (it dropped 3). The totalCount
  // invariant sees 3 == 3 and reports clean — the exact cancellation that makes
  // a count insufficient. Per-id enumeration is independent of the count.
  const indexerTradeIds = ['1', '2', '9999'];
  assert.equal(indexerTradeIds.length, 3); // == chain counter, count check passes

  const findings = detectIndexerOnlyTradeIds({ indexerTradeIds, boundary: boundary(3n) });
  assert.deepEqual(
    findings.map((finding) => finding.tradeId),
    ['9999'],
  );
});

test('enumeration flags non-positive and non-numeric indexer ids', () => {
  const findings = detectIndexerOnlyTradeIds({
    indexerTradeIds: ['0', 'not-a-number', '2'],
    boundary: boundary(3n),
  });

  assert.deepEqual(findings.map((finding) => finding.tradeId).sort(), ['0', 'not-a-number']);
});

test('enumeration reports nothing when every indexer id is chain-allocated', () => {
  const findings = detectIndexerOnlyTradeIds({
    indexerTradeIds: ['1', '2', '3'],
    boundary: boundary(3n),
  });

  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Issue 2 (paired with the anchor): with both sides at the same block a trade
// created after the boundary is simply outside the window, not a false gap.
// ---------------------------------------------------------------------------

test('a trade beyond the anchored counter is outside the window, not a false onchain-missing', () => {
  // Counter resolved at the anchored (indexer) block is 2. An indexer record
  // for id 3, created after the anchor, is caught by enumeration as a real
  // indexer-only record rather than silently compared at a mismatched height.
  const window = planCoverageWindow({ cursor: 0n, chainTradeCounter: 2n, budget: 10 });
  const chainTrades: ChainTradeRecord[] = [
    { tradeId: '1', trade: chainTrade('1') },
    { tradeId: '2', trade: chainTrade('2') },
  ];

  const comparison = compareCoverage({
    window,
    boundary: boundary(2n),
    chainTrades,
    indexedTrades: [indexedTrade('1'), indexedTrade('2')],
  });

  assert.deepEqual(comparison.missingFromIndexer, []);
  assert.equal(comparison.paired.length, 2);
});
