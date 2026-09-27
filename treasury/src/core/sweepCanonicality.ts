/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08 / PRES-05. A sweep batch is the path by which accrued fees leave
 * treasury, so it must never carry a ledger entry the canonical chain no longer
 * contains.
 *
 * The per-entry handoff and the export already re-derive canonicality before
 * they act, but a batch reached approval and close on allocation alone: an
 * entry orphaned by a reorganization stayed allocated, the batch total still
 * matched, and the batch could be approved and closed around it. The
 * controller re-derives the verdict from the chain before each of those
 * decisions; this module is the second half, checked inside the transaction
 * that writes the decision, so an orphaning that commits between the two cannot
 * slip through.
 */
import type { ChainCanonicalityState } from './chainCanonicality';
import type { SweepBatchStatus } from '../types';

/**
 * The transitions that commit to moving value or to declaring it moved.
 * DRAFT and VOID stay open so a blocked batch can always be withdrawn, and
 * EXECUTED and HANDED_OFF record facts that have already happened -- refusing
 * to record them would hide the value movement rather than prevent it. Close
 * is where an entry orphaned after execution is caught.
 */
const TRANSITIONS_REQUIRING_CANONICAL_ENTRIES: ReadonlySet<SweepBatchStatus> = new Set([
  'PENDING_APPROVAL',
  'APPROVED',
  'CLOSED',
]);

export interface SweepEntryCanonicality {
  ledgerEntryId: number;
  canonicalityState: ChainCanonicalityState;
}

export class SweepCanonicalityError extends Error {
  readonly entryIds: number[];

  constructor(message: string, entryIds: number[]) {
    super(message);
    this.name = 'SweepCanonicalityError';
    this.entryIds = entryIds;
  }
}

export function sweepTransitionRequiresCanonicalEntries(status: SweepBatchStatus): boolean {
  return TRANSITIONS_REQUIRING_CANONICAL_ENTRIES.has(status);
}

/**
 * UNVERIFIED is refused as firmly as ORPHANED. An entry nobody has proved is
 * still on the chain is not evidence a batch may commit value against.
 */
export function assertSweepEntriesCanonical(entries: SweepEntryCanonicality[]): void {
  const blocked = entries.filter((entry) => entry.canonicalityState !== 'CANONICAL');
  if (blocked.length === 0) {
    return;
  }

  const described = blocked
    .map((entry) => `${entry.ledgerEntryId} (${entry.canonicalityState})`)
    .join(', ');
  throw new SweepCanonicalityError(
    `Sweep batch ledger entries are not proven canonical: ${described}`,
    blocked.map((entry) => entry.ledgerEntryId),
  );
}
