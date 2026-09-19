/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RealizationReconciliationBinding } from '../core/accountingPolicy';
import type { TradeReconciliationGate } from '../core/reconciliationGate';
import { getLedgerEntryById } from '../database/queries';

interface ReconciliationGateReader {
  assessTrades(tradeIds: string[]): Promise<Map<string, TradeReconciliationGate>>;
}

/**
 * WP-4 H-25. Reconciliation lives in its own database, so the run and its
 * watermark are read here and handed to the write, which re-derives the
 * entry's block before storing the comparison. A run that is missing, stale,
 * drifted, out of scope or short of this entry yields no binding, and
 * realization is refused rather than recorded without evidence.
 */
export async function resolveRealizationBinding(
  reconciliationGate: ReconciliationGateReader,
  entryId: number,
): Promise<RealizationReconciliationBinding | null> {
  const entry = await getLedgerEntryById(entryId);
  if (!entry) {
    return null;
  }

  const gate = (await reconciliationGate.assessTrades([entry.trade_id])).get(entry.trade_id);
  if (!gate || gate.status !== 'CLEAR' || gate.coverageToBlock === null) {
    return null;
  }

  return {
    runKey: gate.runKey ?? 'unknown',
    coverageToBlock: gate.coverageToBlock,
    entryBlockNumber: entry.block_number,
  };
}
