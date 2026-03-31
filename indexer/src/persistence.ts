import {
  AdminAddProposal,
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
  adminAddProposals: Iterable<AdminAddProposal>;
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

export async function persistIndexerBatch(store: IndexerStore, state: IndexerBatchState): Promise<void> {
  await upsertIfPresent(store, state.trades);
  await upsertIfPresent(store, state.tradeEvents);
  await upsertIfPresent(store, state.disputeProposals);
  await upsertIfPresent(store, state.disputeEvents);
  await upsertIfPresent(store, state.oracleUpdateProposals);
  await upsertIfPresent(store, state.oracleEvents);
  await upsertIfPresent(store, state.adminAddProposals);
  await upsertIfPresent(store, state.adminEvents);
  await upsertIfPresent(store, state.systemEvents);
  await store.upsert([state.overviewSnapshot]);
}
