import type { CoverageBoundary, DriftFinding } from '../types';

/** Detect repeated projected trade identities in the independent indexer walk. */
export function detectDuplicateIndexerTradeIds(input: {
  indexerTradeIds: string[];
  boundary: CoverageBoundary;
}): DriftFinding[] {
  const counts = new Map<string, number>();
  for (const id of input.indexerTradeIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([tradeId, count]) => ({
      tradeId,
      severity: 'CRITICAL' as const,
      mismatchCode: 'INDEXER_DUPLICATE_TRADE' as const,
      comparedField: 'tradePresence',
      onchainValue: null,
      indexedValue: String(count),
      details: {
        reason: 'duplicate indexer trade identity',
        boundaryBlock: input.boundary.blockNumber,
      },
    }));
}
