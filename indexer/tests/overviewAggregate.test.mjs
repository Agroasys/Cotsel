import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyOverviewCounters,
  applyTradeCreated,
  applyTradeTransition,
} from '../lib/overviewAggregate.js';
import { TradeStatus } from '../lib/model/index.js';

test('applyTradeCreated increments total trades and the initial status bucket', () => {
  const counters = createEmptyOverviewCounters();

  const created = applyTradeCreated(TradeStatus.LOCKED, counters);

  assert.deepEqual(created, {
    totalTrades: 1,
    lockedTrades: 1,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 0,
    disputedTrades: 0,
    cancelledTrades: 0,
  });
  assert.deepEqual(counters, createEmptyOverviewCounters(), 'input counters must remain unchanged');
});

test('applyTradeTransition preserves total and moves counts between buckets', () => {
  const startingCounters = {
    totalTrades: 5,
    lockedTrades: 1,
    stage1Trades: 1,
    stage2Trades: 1,
    completedTrades: 1,
    disputedTrades: 1,
    cancelledTrades: 0,
  };

  const cases = [
    [TradeStatus.LOCKED, TradeStatus.IN_TRANSIT, { lockedTrades: 0, stage1Trades: 2, stage2Trades: 1, completedTrades: 1, disputedTrades: 1 }],
    [TradeStatus.IN_TRANSIT, TradeStatus.ARRIVAL_CONFIRMED, { lockedTrades: 1, stage1Trades: 0, stage2Trades: 2, completedTrades: 1, disputedTrades: 1 }],
    [TradeStatus.ARRIVAL_CONFIRMED, TradeStatus.CLOSED, { lockedTrades: 1, stage1Trades: 1, stage2Trades: 0, completedTrades: 2, disputedTrades: 1 }],
    [TradeStatus.LOCKED, TradeStatus.FROZEN, { lockedTrades: 0, stage1Trades: 1, stage2Trades: 1, completedTrades: 1, disputedTrades: 2 }],
    [TradeStatus.FROZEN, TradeStatus.CLOSED, { lockedTrades: 1, stage1Trades: 1, stage2Trades: 1, completedTrades: 2, disputedTrades: 0 }],
  ];

  for (const [fromStatus, toStatus, expectedBuckets] of cases) {
    const updated = applyTradeTransition(fromStatus, toStatus, startingCounters);

    assert.equal(updated.totalTrades, startingCounters.totalTrades);
    assert.equal(updated.lockedTrades, expectedBuckets.lockedTrades);
    assert.equal(updated.stage1Trades, expectedBuckets.stage1Trades);
    assert.equal(updated.stage2Trades, expectedBuckets.stage2Trades);
    assert.equal(updated.completedTrades, expectedBuckets.completedTrades);
    assert.equal(updated.disputedTrades, expectedBuckets.disputedTrades);
    assert.equal(updated.cancelledTrades, 0);
  }
});

test('applyTradeTransition is a no-op when status does not change', () => {
  const counters = {
    totalTrades: 2,
    lockedTrades: 0,
    stage1Trades: 1,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 0,
  };

  const updated = applyTradeTransition(TradeStatus.IN_TRANSIT, TradeStatus.IN_TRANSIT, counters);

  assert.deepEqual(updated, counters);
  assert.notEqual(updated, counters, 'result should be a cloned object for deterministic callers');
});

test('applyTradeTransition rejects counter underflow', () => {
  const counters = createEmptyOverviewCounters();

  assert.throws(
    () => applyTradeTransition(TradeStatus.LOCKED, TradeStatus.IN_TRANSIT, counters),
    /underflow/,
  );
});
