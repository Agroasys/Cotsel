import { TradeStatus } from './model';

export const OVERVIEW_SNAPSHOT_ID = 'singleton';

export interface OverviewCounters {
  totalTrades: number;
  lockedTrades: number;
  stage1Trades: number;
  stage2Trades: number;
  completedTrades: number;
  disputedTrades: number;
  cancelledTrades: number;
}

export function createEmptyOverviewCounters(): OverviewCounters {
  return {
    totalTrades: 0,
    lockedTrades: 0,
    stage1Trades: 0,
    stage2Trades: 0,
    completedTrades: 0,
    disputedTrades: 0,
    cancelledTrades: 0,
  };
}

export function applyTradeCreated(initialStatus: TradeStatus, counters: OverviewCounters): OverviewCounters {
  const next = { ...counters, totalTrades: counters.totalTrades + 1 };
  incrementStatusBucket(initialStatus, next);
  return next;
}

export function applyTradeTransition(
  prevStatus: TradeStatus,
  nextStatus: TradeStatus,
  counters: OverviewCounters,
): OverviewCounters {
  if (prevStatus === nextStatus) {
    return { ...counters };
  }

  const next = { ...counters };
  decrementStatusBucket(prevStatus, next);
  incrementStatusBucket(nextStatus, next);
  return next;
}

export function applyTradeCancelled(
  prevStatus: TradeStatus,
  counters: OverviewCounters,
): OverviewCounters {
  const next = { ...counters };
  decrementStatusBucket(prevStatus, next);
  next.cancelledTrades += 1;
  return next;
}

function incrementStatusBucket(status: TradeStatus, counters: OverviewCounters): void {
  switch (status) {
    case TradeStatus.LOCKED:
      counters.lockedTrades += 1;
      return;
    case TradeStatus.IN_TRANSIT:
      counters.stage1Trades += 1;
      return;
    case TradeStatus.ARRIVAL_CONFIRMED:
      counters.stage2Trades += 1;
      return;
    case TradeStatus.CLOSED:
      counters.completedTrades += 1;
      return;
    case TradeStatus.FROZEN:
      counters.disputedTrades += 1;
      return;
    default: {
      const exhaustiveCheck: never = status;
      throw new Error(`Unsupported trade status: ${String(exhaustiveCheck)}`);
    }
  }
}

function decrementStatusBucket(status: TradeStatus, counters: OverviewCounters): void {
  const decrement = (key: keyof OverviewCounters) => {
    if (counters[key] <= 0) {
      throw new Error(`Overview counter underflow for ${String(key)}`);
    }

    counters[key] -= 1;
  };

  switch (status) {
    case TradeStatus.LOCKED:
      decrement('lockedTrades');
      return;
    case TradeStatus.IN_TRANSIT:
      decrement('stage1Trades');
      return;
    case TradeStatus.ARRIVAL_CONFIRMED:
      decrement('stage2Trades');
      return;
    case TradeStatus.CLOSED:
      decrement('completedTrades');
      return;
    case TradeStatus.FROZEN:
      decrement('disputedTrades');
      return;
    default: {
      const exhaustiveCheck: never = status;
      throw new Error(`Unsupported trade status: ${String(exhaustiveCheck)}`);
    }
  }
}
