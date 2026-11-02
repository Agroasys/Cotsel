import { config } from '../config';
import type { IndexerClient } from '../indexer/client';
import type { CoverageBoundary, DriftFinding } from '../types';
import {
  createEnumerationCycle,
  hasEnumerationHistory,
  indexerSourceIdentity,
  previousIdentityCounts,
  readActiveEnumerationCycle,
  sameCycleSource,
  type EnumerationCycle,
  type IdentityPage,
} from '../database/enumerationCycles';

export async function prepareEnumeration(
  client: IndexerClient,
  boundary: CoverageBoundary,
  previousCursor: bigint,
): Promise<{
  cycle: EnumerationCycle;
  chainCursor: bigint;
  coherent: boolean;
}> {
  let cycle = await readActiveEnumerationCycle();
  let chainCursor = previousCursor;
  if (!cycle) {
    // A pre-migration cursor has no cumulative scope. Finish that discovery cycle
    // as unproven, then start a complete validation epoch from zero.
    const history = await hasEnumerationHistory();
    if (history) chainCursor = 0n;
    const [upperId, expectedCount] = await Promise.all([
      client.fetchTradeIdUpperBound(),
      client.fetchTradeCount(),
    ]);
    cycle = await createEnumerationCycle({
      boundary,
      source: indexerSourceIdentity(config.indexerGraphqlUrl),
      upperId,
      expectedCount,
      chainCursor,
      coherent: chainCursor === 0n,
    });
  }
  return {
    cycle,
    chainCursor: BigInt(cycle.chain_cursor),
    coherent: sameCycleSource(cycle, boundary, indexerSourceIdentity(config.indexerGraphqlUrl)),
  };
}

/** Each invocation consumes a bounded page budget. No offset is reconstructed on restart. */
export async function enumerateIndexer(
  client: IndexerClient,
  cycle: EnumerationCycle,
): Promise<{
  page: IdentityPage;
  tradeIds: string[];
  truncated: boolean;
  duplicates: DriftFinding[];
}> {
  const page: IdentityPage = { records: [], nextId: cycle.after_id, exhausted: cycle.exhausted };
  while (!page.exhausted && page.records.length < config.indexerEnumerationLimit) {
    const next = await client.fetchTradeIdsPage({
      afterId: page.nextId,
      throughId: cycle.upper_id,
      limit: Math.min(
        config.indexerEnumerationPageSize,
        config.indexerEnumerationLimit - page.records.length,
      ),
    });
    page.records.push(...next.records);
    page.nextId = next.nextId;
    page.exhausted = next.exhausted;
  }
  const tradeIds = page.records.map((row) => row.tradeId);
  const counts = await previousIdentityCounts(cycle.id, tradeIds);
  const repeated = new Set<string>();
  for (const id of tradeIds) {
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (count > 1) repeated.add(id);
  }
  const duplicates: DriftFinding[] = [...repeated].map((tradeId) => ({
    tradeId,
    severity: 'CRITICAL',
    mismatchCode: 'INDEXER_DUPLICATE_TRADE',
    comparedField: 'tradePresence',
    onchainValue: null,
    indexedValue: String(counts.get(tradeId)),
    details: {
      reason: 'duplicate indexer trade identity across independent pages',
      cycleId: cycle.id,
    },
  }));
  return { page, tradeIds, truncated: !page.exhausted, duplicates };
}

/** A stable projection height is insufficient when its chain anchor reorganizes. */
export async function verifyCycleBoundary(
  client: import('../blockchain/client').OnchainClient,
  boundary: CoverageBoundary,
): Promise<void> {
  const current = await client.resolveBoundary(boundary.indexerProcessedBlock);
  if (
    current.blockNumber !== boundary.blockNumber ||
    current.blockHash.toLowerCase() !== boundary.blockHash.toLowerCase() ||
    current.chainTradeCounter !== boundary.chainTradeCounter
  )
    throw new Error('Reconciliation chain anchor changed before publication');
}
