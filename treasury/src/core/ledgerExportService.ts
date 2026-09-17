/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getLedgerEntriesForExport, getLedgerExportSnapshot } from '../database/queries';
import type { LedgerEntryWithState } from '../types';
import { buildExportPage, type ExportPage, type ExportRequest } from './ledgerExport';

/**
 * Annotation is supplied by the caller because eligibility needs the RPC head
 * and the reconciliation gate, which belong to the controller's wiring rather
 * than to the export contract.
 */
export type AnnotatedLedgerEntry = LedgerEntryWithState & { eligibleForExport: boolean };

export interface LedgerExportReader {
  loadSnapshot: typeof getLedgerExportSnapshot;
  loadCandidates: typeof getLedgerEntriesForExport;
}

const defaultReader: LedgerExportReader = {
  loadSnapshot: getLedgerExportSnapshot,
  loadCandidates: getLedgerEntriesForExport,
};

/**
 * Reads one keyset page at the request's cutoff, annotates it, and folds it into
 * an export page. The snapshot and the page are read concurrently: both are
 * bounded by the same cutoff, so neither can observe rows the other cannot.
 */
export async function loadLedgerExportPage<TEntry extends AnnotatedLedgerEntry>(
  request: ExportRequest,
  annotate: (entries: LedgerEntryWithState[]) => Promise<TEntry[]>,
  reader: LedgerExportReader = defaultReader,
): Promise<ExportPage<TEntry>> {
  const [snapshot, candidatePage] = await Promise.all([
    reader.loadSnapshot(request.cutoff),
    reader.loadCandidates({
      cutoff: request.cutoff,
      cursor: request.cursor,
      limit: request.limit,
    }),
  ]);

  const annotated = await annotate(candidatePage.entries);

  return buildExportPage({
    request,
    snapshot,
    candidates: annotated,
    hasMore: candidatePage.hasMore,
    selectExportable: (entry) => entry.eligibleForExport,
    readAmountRaw: (entry) => entry.amount_raw,
    readCursor: (entry) => ({ createdAt: new Date(entry.created_at), id: entry.id }),
  });
}
