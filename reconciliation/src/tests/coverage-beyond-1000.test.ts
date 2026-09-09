import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareCoverage,
  evaluateCoverageSla,
  planCoverageWindow,
  tradeIdsInWindow,
  type ChainTradeRecord,
} from '../core/coverage';
import type { CoverageBoundary, IndexedTradeRecord } from '../types';
import { TradeStatus, type Trade } from '@agroasys/sdk';

/**
 * FAIL-07: a dataset beyond 1,000 trades must prove that every record is
 * enumerated, that an induced backlog is detected, and that no run reports a
 * complete sweep until the entire range has reconciled.
 *
 * The old reconciler stopped at RECONCILIATION_MAX_TRADES_PER_RUN=1000 and
 * still reported success, so trade 1001 onwards was never compared at all.
 */

const CHAIN_TRADE_COUNT = 2_500n;
const BUDGET = 1_000;

function boundary(chainTradeCounter: bigint): CoverageBoundary {
  return {
    blockNumber: 1_000_000,
    blockHash: '0xboundary',
    tag: 'finalized',
    chainTradeCounter,
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

/** Drive successive runs the way the daemon does, carrying the cursor forward. */
function sweep(input: { indexerHas: (tradeId: string) => boolean }) {
  const enumerated: string[] = [];
  const gaps: string[] = [];
  const runs: Array<{ from: bigint; to: bigint; tail: bigint; complete: boolean }> = [];

  let cursor = 0n;
  for (let guard = 0; guard < 100; guard += 1) {
    const window = planCoverageWindow({
      cursor,
      chainTradeCounter: CHAIN_TRADE_COUNT,
      budget: BUDGET,
    });

    const ids = tradeIdsInWindow(window);
    if (ids.length === 0) {
      break;
    }

    const chainTrades: ChainTradeRecord[] = ids.map((tradeId) => ({
      tradeId,
      trade: chainTrade(tradeId),
    }));
    const indexedTrades = ids.filter(input.indexerHas).map(indexedTrade);

    const comparison = compareCoverage({
      window,
      boundary: boundary(CHAIN_TRADE_COUNT),
      chainTrades,
      indexedTrades,
    });

    enumerated.push(...ids);
    gaps.push(
      ...comparison.missingFromIndexer
        .filter((finding) => finding.mismatchCode === 'INDEXER_TRADE_MISSING')
        .map((finding) => finding.tradeId),
    );
    runs.push({
      from: window.fromTradeId,
      to: window.toTradeId,
      tail: window.uncoveredTail,
      complete: window.complete,
    });

    cursor = window.nextCursor;
  }

  return { enumerated, gaps, runs, finalCursor: cursor };
}

test('every trade beyond the former 1,000 cap is enumerated exactly once', () => {
  const { enumerated, runs, finalCursor } = sweep({ indexerHas: () => true });

  assert.equal(enumerated.length, Number(CHAIN_TRADE_COUNT));
  assert.equal(new Set(enumerated).size, Number(CHAIN_TRADE_COUNT));
  assert.equal(enumerated[0], '1');
  assert.equal(enumerated[enumerated.length - 1], CHAIN_TRADE_COUNT.toString());
  assert.equal(finalCursor, CHAIN_TRADE_COUNT);

  // 2,500 trades over a 1,000 budget: three runs, and only the last is complete.
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((run) => [run.from.toString(), run.to.toString(), run.tail.toString()]),
    [
      ['1', '1000', '1500'],
      ['1001', '2000', '500'],
      ['2001', '2500', '0'],
    ],
  );
  assert.deepEqual(
    runs.map((run) => run.complete),
    [false, false, true],
  );
});

test('a trade past the former cap is still compared against the indexer', () => {
  // Trade 1,742 sits in the tail the old fixed cap never reached.
  const { gaps } = sweep({ indexerHas: (tradeId) => tradeId !== '1742' });

  assert.deepEqual(gaps, ['1742']);
});

test('an induced backlog is detected once the tail outlives its SLA', () => {
  const firstRun = planCoverageWindow({
    cursor: 0n,
    chainTradeCounter: CHAIN_TRADE_COUNT,
    budget: BUDGET,
  });
  const tailFirstSeenAt = new Date('2026-09-09T00:00:00Z');

  const fresh = evaluateCoverageSla({
    uncoveredTail: firstRun.uncoveredTail,
    tailFirstSeenAt,
    now: new Date('2026-09-09T00:10:00Z'),
    maxAgeMs: 3_600_000,
  });
  assert.equal(fresh.breached, false);

  const stale = evaluateCoverageSla({
    uncoveredTail: firstRun.uncoveredTail,
    tailFirstSeenAt,
    now: new Date('2026-09-09T03:00:00Z'),
    maxAgeMs: 3_600_000,
  });
  assert.equal(stale.breached, true);
  assert.equal(stale.uncoveredTail, 1_500n);
});

test('no run reports a complete sweep while any of the range is unreconciled', () => {
  const { runs } = sweep({ indexerHas: () => true });
  const incomplete = runs.filter((run) => !run.complete);

  assert.equal(incomplete.length, 2);
  for (const run of incomplete) {
    assert.ok(run.tail > 0n, 'an incomplete run must publish a non-zero uncovered tail');
  }
});
