import {
  AdminChangeProposal,
  AdminEvent,
  DisputeEvent,
  DisputeProposal,
  OracleEvent,
  OracleUpdateProposal,
  OverviewSnapshot,
  SystemEvent,
  Trade,
  TradeEvent,
} from './model';

export interface IndexerStore {
  upsert(entities: unknown[]): Promise<void>;
}

export interface IndexerBatchState {
  trades: Iterable<Trade>;
  tradeEvents: Iterable<TradeEvent>;
  disputeProposals: Iterable<DisputeProposal>;
  disputeEvents: Iterable<DisputeEvent>;
  oracleUpdateProposals: Iterable<OracleUpdateProposal>;
  oracleEvents: Iterable<OracleEvent>;
  adminChangeProposals: Iterable<AdminChangeProposal>;
  adminEvents: Iterable<AdminEvent>;
  systemEvents: Iterable<SystemEvent>;
  overviewSnapshot: OverviewSnapshot;
}

async function upsertIfPresent(store: IndexerStore, entities: Iterable<unknown>): Promise<void> {
  const batch = Array.from(entities);
  if (batch.length > 0) {
    await store.upsert(batch);
  }
}

export async function persistIndexerBatch(
  store: IndexerStore,
  state: IndexerBatchState,
): Promise<void> {
  await upsertIfPresent(store, state.trades);
  await upsertIfPresent(store, state.tradeEvents);
  await upsertIfPresent(store, state.disputeProposals);
  await upsertIfPresent(store, state.disputeEvents);
  await upsertIfPresent(store, state.oracleUpdateProposals);
  await upsertIfPresent(store, state.oracleEvents);
  await upsertIfPresent(store, state.adminChangeProposals);
  await upsertIfPresent(store, state.adminEvents);
  await upsertIfPresent(store, state.systemEvents);
  await store.upsert([state.overviewSnapshot]);
}

/** Only PostgreSQL data/constraint failures identify a durable poison batch.
 * Transport, retryable, and unclassified failures retain Subsquid retry behavior.
 */
export function isNonRetryablePersistenceError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const value = current as { code?: unknown; driverError?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code))
      return value.code.startsWith('22') || value.code.startsWith('23');
    pending.push(value.driverError, value.cause);
  }
  return false;
}
