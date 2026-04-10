import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyOverviewCounters,
  applyTradeCreated,
  applyTradeCancelled,
  applyTradeTransition,
  buildCountersFromExistingState,
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
    [
      TradeStatus.LOCKED,
      TradeStatus.IN_TRANSIT,
      { lockedTrades: 0, stage1Trades: 2, stage2Trades: 1, completedTrades: 1, disputedTrades: 1 },
    ],
    [
      TradeStatus.IN_TRANSIT,
      TradeStatus.ARRIVAL_CONFIRMED,
      { lockedTrades: 1, stage1Trades: 0, stage2Trades: 2, completedTrades: 1, disputedTrades: 1 },
    ],
    [
      TradeStatus.ARRIVAL_CONFIRMED,
      TradeStatus.CLOSED,
      { lockedTrades: 1, stage1Trades: 1, stage2Trades: 0, completedTrades: 2, disputedTrades: 1 },
    ],
    [
      TradeStatus.LOCKED,
      TradeStatus.FROZEN,
      { lockedTrades: 0, stage1Trades: 1, stage2Trades: 1, completedTrades: 1, disputedTrades: 2 },
    ],
    [
      TradeStatus.FROZEN,
      TradeStatus.CLOSED,
      { lockedTrades: 1, stage1Trades: 1, stage2Trades: 1, completedTrades: 2, disputedTrades: 0 },
    ],
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

test('applyTradeCancelled preserves total and records terminal cancellation separately from completion', () => {
  const counters = {
    totalTrades: 3,
    lockedTrades: 1,
    stage1Trades: 1,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 0,
  };

  const cancelledFromLocked = applyTradeCancelled(TradeStatus.LOCKED, counters);
  assert.deepEqual(cancelledFromLocked, {
    totalTrades: 3,
    lockedTrades: 0,
    stage1Trades: 1,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 1,
  });

  const cancelledFromTransit = applyTradeCancelled(TradeStatus.IN_TRANSIT, counters);
  assert.deepEqual(cancelledFromTransit, {
    totalTrades: 3,
    lockedTrades: 1,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 1,
  });
});

test('buildCountersFromExistingState classifies terminal closed trades from their latest terminal event', () => {
  const counters = buildCountersFromExistingState(
    [
      { id: 'trade-1', status: TradeStatus.CLOSED },
      { id: 'trade-2', status: TradeStatus.CLOSED },
      { id: 'trade-3', status: TradeStatus.ARRIVAL_CONFIRMED },
      { id: 'trade-4', status: TradeStatus.FROZEN },
    ],
    new Map([
      ['trade-1', 'FinalTrancheReleased'],
      ['trade-2', 'InTransitTimeoutRefunded'],
    ]),
  );

  assert.deepEqual(counters, {
    totalTrades: 4,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 1,
    completedTrades: 1,
    disputedTrades: 1,
    cancelledTrades: 1,
  });
});

test('buildCountersFromExistingState defaults closed trades without cancellation events to completed', () => {
  const counters = buildCountersFromExistingState(
    [{ id: 'trade-1', status: TradeStatus.CLOSED }],
    new Map(),
  );

  assert.deepEqual(counters, {
    totalTrades: 1,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 0,
  });
});

test('DisputePayout REFUND: applyTradeCancelled from FROZEN lands in cancelledTrades', () => {
  const counters = {
    totalTrades: 3,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 1,
    cancelledTrades: 0,
  };

  const result = applyTradeCancelled(TradeStatus.FROZEN, counters);

  assert.deepEqual(result, {
    totalTrades: 3,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 1,
  });
  assert.deepEqual(counters.cancelledTrades, 0, 'input counters must remain unchanged');
});

test('DisputePayout RESOLVE: applyTradeTransition from FROZEN to CLOSED lands in completedTrades', () => {
  const counters = {
    totalTrades: 3,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 1,
    cancelledTrades: 0,
  };

  const result = applyTradeTransition(TradeStatus.FROZEN, TradeStatus.CLOSED, counters);

  assert.deepEqual(result, {
    totalTrades: 3,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 2,
    disputedTrades: 0,
    cancelledTrades: 0,
  });
  assert.deepEqual(counters.completedTrades, 1, 'input counters must remain unchanged');
});

test('buildCountersFromExistingState classifies DisputePayout:REFUND terminal event as cancelled', () => {
  const counters = buildCountersFromExistingState(
    [
      { id: 'trade-1', status: TradeStatus.CLOSED },
      { id: 'trade-2', status: TradeStatus.CLOSED },
    ],
    new Map([
      ['trade-1', 'DisputePayout:REFUND'],
      ['trade-2', 'FinalTrancheReleased'],
    ]),
  );

  assert.deepEqual(counters, {
    totalTrades: 2,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 1,
  });
});

test('buildCountersFromExistingState classifies DisputePayout (RESOLVE) terminal event as completed', () => {
  const counters = buildCountersFromExistingState(
    [{ id: 'trade-1', status: TradeStatus.CLOSED }],
    new Map([['trade-1', 'DisputePayout']]),
  );

  assert.deepEqual(counters, {
    totalTrades: 1,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 1,
    disputedTrades: 0,
    cancelledTrades: 0,
  });
});

test('live and backfill paths agree: REFUND payout increments cancelledTrades in both', () => {
  const liveCounters = {
    totalTrades: 1,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 0,
    disputedTrades: 1,
    cancelledTrades: 0,
  };
  const liveResult = applyTradeCancelled(TradeStatus.FROZEN, liveCounters);
  assert.equal(liveResult.cancelledTrades, 1);
  assert.equal(liveResult.completedTrades, 0);

  const backfillResult = buildCountersFromExistingState(
    [{ id: 'trade-1', status: TradeStatus.CLOSED }],
    new Map([['trade-1', 'DisputePayout:REFUND']]),
  );
  assert.equal(backfillResult.cancelledTrades, 1);
  assert.equal(backfillResult.completedTrades, 0);
});

test('live and backfill paths agree: RESOLVE payout increments completedTrades in both', () => {
  const liveCounters = {
    totalTrades: 1,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 0,
    disputedTrades: 1,
    cancelledTrades: 0,
  };
  const liveResult = applyTradeTransition(TradeStatus.FROZEN, TradeStatus.CLOSED, liveCounters);
  assert.equal(liveResult.completedTrades, 1);
  assert.equal(liveResult.cancelledTrades, 0);

  const backfillResult = buildCountersFromExistingState(
    [{ id: 'trade-1', status: TradeStatus.CLOSED }],
    new Map([['trade-1', 'DisputePayout']]),
  );
  assert.equal(backfillResult.completedTrades, 1);
  assert.equal(backfillResult.cancelledTrades, 0);
});
