/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { LedgerEntryForExport } from '../database/queries/ledger';
import type { EligibilitySummary } from './controller';

export function toCsv(entries: Array<LedgerEntryForExport & EligibilitySummary>): string {
  const headers = [
    'id',
    'trade_id',
    'tx_hash',
    'block_number',
    'event_name',
    'component_type',
    'amount_raw',
    'latest_state',
    'confirmation_stage',
    'reconciliation_status',
    'reconciliation_freshness',
    'reconciliation_completed_at',
    'stale_running_run_count',
    'eligible_for_export',
    'blocked_reasons',
    'latest_state_at',
    'created_at',
  ];

  const rows = entries.map((entry) => [
    entry.id,
    entry.trade_id,
    entry.tx_hash,
    entry.block_number,
    entry.event_name,
    entry.component_type,
    entry.amount_raw,
    entry.latest_state ?? '',
    entry.confirmationStage ?? '',
    entry.reconciliationStatus,
    entry.reconciliationFreshness,
    entry.reconciliationCompletedAt ?? '',
    entry.staleRunningRunCount,
    entry.eligibleForExport ? 'true' : 'false',
    entry.blockedReasons.join('|'),
    entry.latest_state_at?.toISOString() ?? '',
    entry.created_at.toISOString(),
  ]);

  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}
