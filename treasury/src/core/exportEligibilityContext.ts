/** SPDX-License-Identifier: Apache-2.0 */
import type { PoolClient } from 'pg';
import type { SnapshotRunSelection } from './reconciliationSnapshot';
import type { IngestionFreshnessAssessment } from './ingestionFreshness';
import type { ReconciliationRunAnchor, TradeReconciliationGate } from './reconciliationGate';

export interface ReconciliationGateReader {
  assessTrades(
    tradeIds: string[],
    selection?: SnapshotRunSelection,
  ): Promise<Map<string, TradeReconciliationGate>>;
  snapshotRunAnchor?(selection?: SnapshotRunSelection): Promise<ReconciliationRunAnchor>;
}

export interface IngestionFreshnessReader {
  assess(options?: {
    stableBlockNumber?: number | null;
    executor?: PoolClient;
  }): Promise<IngestionFreshnessAssessment>;
}

export interface SettlementHeadProvider {
  getBlock(
    tag: 'latest' | 'safe' | 'finalized' | number,
  ): Promise<{ number: bigint | number; hash?: string | null } | null>;
}

export interface SnapshotEligibilityContext {
  heads: {
    latestBlockNumber: number;
    safeBlockNumber: number | null;
    finalizedBlockNumber: number;
  };
  finalizedBlockHash: string;
  chainVerifiedAt?: Date;
  ingestion: IngestionFreshnessAssessment;
  reconciliationRunKey: string | null;
  reconciliationByTradeId: Map<string, TradeReconciliationGate>;
  reconciliationRunAnchor?: ReconciliationRunAnchor;
}

function stableEvidence(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableEvidence(item)]),
    );
  }
  return value;
}

export function sameReconciliationGate(
  a: TradeReconciliationGate,
  b: TradeReconciliationGate,
): boolean {
  return JSON.stringify(stableEvidence(a)) === JSON.stringify(stableEvidence(b));
}

export function sameIngestionEvidence(
  a: IngestionFreshnessAssessment,
  b: IngestionFreshnessAssessment,
): boolean {
  return (
    JSON.stringify(stableEvidence({ ...a, ageSeconds: null })) ===
    JSON.stringify(stableEvidence({ ...b, ageSeconds: null }))
  );
}

/** Recheck the original anchor and each retained reconciliation verdict without a database transaction. */
export async function verifySnapshotEvidence(input: {
  context: SnapshotEligibilityContext;
  provider: SettlementHeadProvider | null;
  ingestion: {
    assess(options: { stableBlockNumber: number }): Promise<IngestionFreshnessAssessment>;
  };
  reconciliation: {
    assessTrades(
      tradeIds: string[],
      selection?: SnapshotRunSelection,
    ): Promise<Map<string, TradeReconciliationGate>>;
    snapshotRunAnchor?(selection?: SnapshotRunSelection): Promise<ReconciliationRunAnchor>;
  };
}): Promise<void> {
  const { context, provider } = input;
  if (!provider || !context.reconciliationRunKey)
    throw new Error('Snapshot evidence is unavailable');
  const [anchor, finalized, ingestion] = await Promise.all([
    provider.getBlock(context.heads.finalizedBlockNumber),
    provider.getBlock('finalized'),
    input.ingestion.assess({ stableBlockNumber: context.heads.finalizedBlockNumber }),
  ]);
  if (
    !anchor ||
    Number(anchor.number) !== context.heads.finalizedBlockNumber ||
    anchor.hash?.toLowerCase() !== context.finalizedBlockHash ||
    !finalized ||
    !Number.isSafeInteger(Number(finalized.number)) ||
    Number(finalized.number) < context.heads.finalizedBlockNumber
  ) {
    throw new Error('Finalized chain anchor changed or is unavailable');
  }
  context.chainVerifiedAt = new Date();
  if (
    ingestion.status !== 'FRESH' ||
    ingestion.blockedReasons.length > 0 ||
    !sameIngestionEvidence(context.ingestion, ingestion)
  ) {
    throw new Error('Ingestion evidence changed or became stale');
  }
  if (context.reconciliationRunAnchor) {
    if (!input.reconciliation.snapshotRunAnchor)
      throw new Error('Reconciliation evidence is unavailable or incomplete');
    const current = await input.reconciliation.snapshotRunAnchor({
      runKey: context.reconciliationRunKey,
      requireImmutable: true,
    });
    if (
      JSON.stringify(stableEvidence(current)) !==
      JSON.stringify(stableEvidence(context.reconciliationRunAnchor))
    ) {
      throw new Error('Reconciliation evidence changed or became unavailable');
    }
  }
  const tradeIds = [...context.reconciliationByTradeId.keys()];
  for (let offset = 0; offset < tradeIds.length; offset += 1000) {
    const batch = tradeIds.slice(offset, offset + 1000);
    const current = await input.reconciliation.assessTrades(batch, {
      runKey: context.reconciliationRunKey,
      requireImmutable: true,
    });
    for (const tradeId of batch) {
      const original = context.reconciliationByTradeId.get(tradeId);
      const observed = current.get(tradeId);
      if (!original || !observed || !sameReconciliationGate(original, observed)) {
        throw new Error('Reconciliation evidence changed or became unavailable');
      }
    }
  }
}

export async function readSettlementHeads(provider: SettlementHeadProvider | null): Promise<{
  heads: {
    latestBlockNumber: number;
    safeBlockNumber: number | null;
    finalizedBlockNumber: number | null;
  } | null;
  failureReason: string | null;
  finalizedBlockHash: string | null;
}> {
  if (!provider) {
    return {
      heads: null,
      failureReason: 'Settlement runtime is not configured for treasury confirmation checks',
      finalizedBlockHash: null,
    };
  }

  const [latestBlock, safeBlock, finalizedBlock] = await Promise.all([
    provider.getBlock('latest'),
    provider.getBlock('safe'),
    provider.getBlock('finalized'),
  ]);

  if (!latestBlock) {
    return {
      heads: null,
      failureReason:
        'Managed RPC provider returned no latest block for treasury confirmation checks',
      finalizedBlockHash: null,
    };
  }

  return {
    heads: {
      latestBlockNumber: Number(latestBlock.number),
      safeBlockNumber: safeBlock ? Number(safeBlock.number) : null,
      finalizedBlockNumber: finalizedBlock ? Number(finalizedBlock.number) : null,
    },
    failureReason: null,
    finalizedBlockHash: finalizedBlock?.hash ?? null,
  };
}

export async function createEligibilitySnapshotContext(
  provider: SettlementHeadProvider | null,
  ingestionReader: {
    assess(options: { stableBlockNumber: number }): Promise<IngestionFreshnessAssessment>;
  },
): Promise<SnapshotEligibilityContext> {
  const { heads, finalizedBlockHash } = await readSettlementHeads(provider);
  if (
    !heads ||
    heads.finalizedBlockNumber === null ||
    !Number.isSafeInteger(heads.finalizedBlockNumber) ||
    heads.finalizedBlockNumber < 0 ||
    !Number.isSafeInteger(heads.latestBlockNumber) ||
    heads.latestBlockNumber < heads.finalizedBlockNumber ||
    (heads.safeBlockNumber !== null &&
      (!Number.isSafeInteger(heads.safeBlockNumber) ||
        heads.safeBlockNumber < heads.finalizedBlockNumber ||
        heads.safeBlockNumber > heads.latestBlockNumber)) ||
    !finalizedBlockHash ||
    !/^0x[0-9a-f]{64}$/i.test(finalizedBlockHash)
  ) {
    throw new Error('Finalized chain anchor is unavailable');
  }
  const ingestion = await ingestionReader.assess({
    stableBlockNumber: heads.finalizedBlockNumber,
  });
  if (ingestion.status !== 'FRESH' || ingestion.blockedReasons.length > 0) {
    throw new Error('Ingestion evidence is unavailable or stale');
  }
  return {
    heads: { ...heads, finalizedBlockNumber: heads.finalizedBlockNumber },
    finalizedBlockHash: finalizedBlockHash.toLowerCase(),
    ingestion,
    reconciliationRunKey: null,
    reconciliationByTradeId: new Map(),
  };
}

/** SQL-only final check after local source locks. Never performs an RPC call. */
export async function verifyPublicationEvidence(
  context: SnapshotEligibilityContext,
  client: PoolClient,
  ingestionReader: {
    assess(options: {
      stableBlockNumber: number;
      executor?: PoolClient;
    }): Promise<IngestionFreshnessAssessment>;
  },
  reconciliation: {
    snapshotRunAnchor?(selection?: SnapshotRunSelection): Promise<ReconciliationRunAnchor>;
  },
): Promise<void> {
  if (!context.reconciliationRunAnchor || !reconciliation.snapshotRunAnchor)
    throw new Error('Reconciliation evidence is unavailable or incomplete');
  const [ingestion, anchor] = await Promise.all([
    ingestionReader.assess({
      stableBlockNumber: context.heads.finalizedBlockNumber,
      executor: client,
    }),
    reconciliation.snapshotRunAnchor({
      runKey: context.reconciliationRunKey ?? undefined,
      requireImmutable: true,
    }),
  ]);
  if (ingestion.status !== 'FRESH' || !sameIngestionEvidence(context.ingestion, ingestion))
    throw new Error('Ingestion evidence changed or became stale');
  if (!context.chainVerifiedAt || Date.now() - context.chainVerifiedAt.getTime() > 30_000)
    throw new Error('Finalized chain verification expired before publication');
  if (!sameReconciliationGateAnchor(context.reconciliationRunAnchor, anchor))
    throw new Error('Reconciliation evidence changed or became unavailable');
}

function sameReconciliationGateAnchor(
  a: ReconciliationRunAnchor,
  b: ReconciliationRunAnchor,
): boolean {
  return JSON.stringify(stableEvidence(a)) === JSON.stringify(stableEvidence(b));
}
