/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08 / PRES-05. Re-derives each entry's verdict from the chain before a
 * sweep decision, which also refreshes the persisted state the query layer
 * re-checks inside the write. Decisions taken before value moves need the full
 * payout gate. Close only needs the entries to still be canonical: the other
 * conditions were cleared before execution, and an entry orphaned since then is
 * the discrepancy close must stop on.
 */
import { HttpError } from '@agroasys/shared-http';
import type { TreasuryEligibilityService } from '../core/exportEligibility';
import { getLedgerEntriesForEligibilityByIds } from '../database/queries';
import type { SweepBatchDetail } from '../types';

export type SweepEligibilityRequirement = 'PAYOUT' | 'CANONICAL';

export class SweepBatchGate {
  constructor(private readonly eligibility: Pick<TreasuryEligibilityService, 'assessEntries'>) {}

  /** The same allocation set the query layer re-checks inside the write. */
  async assertBatch(
    detail: SweepBatchDetail,
    requirement: SweepEligibilityRequirement,
  ): Promise<void> {
    await this.assertEntries(
      detail.entries
        .filter((entry) => entry.allocation_status === 'ALLOCATED')
        .map((entry) => entry.ledger_entry_id),
      requirement,
    );
  }

  async assertEntries(
    ledgerEntryIds: number[],
    requirement: SweepEligibilityRequirement,
  ): Promise<void> {
    const entries = await getLedgerEntriesForEligibilityByIds(ledgerEntryIds);
    const eligibility = await this.eligibility.assessEntries(entries);
    const blocked = entries.flatMap((entry) => {
      const gate = eligibility.get(entry.id);
      const cleared =
        requirement === 'PAYOUT'
          ? gate?.eligibleForPayout === true
          : gate?.canonicalityState === 'CANONICAL';
      return cleared
        ? []
        : [
            {
              entryId: entry.id,
              canonicalityState: gate?.canonicalityState ?? null,
              blockedReasons: gate?.blockedReasons ?? ['Eligibility state unavailable'],
            },
          ];
    });

    if (blocked.length > 0) {
      throw new HttpError(
        409,
        'SweepEligibilityBlocked',
        requirement === 'PAYOUT'
          ? 'Sweep batch ledger entries are not eligible for payout'
          : 'Sweep batch ledger entries are no longer proven canonical',
        { entries: blocked },
      );
    }
  }
}
