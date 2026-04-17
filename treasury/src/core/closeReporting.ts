import {
  getAccountingPeriodById,
  getSweepBatchDetail,
  getTreasuryClaimEventByBatchId,
  listLedgerEntryAccountingProjections,
  listSweepBatches,
} from '../database/queries';
import {
  AccountingPeriod,
  LedgerEntryAccountingProjection,
  SweepBatchWithPeriod,
  TreasuryAccountingPeriodClosePacket,
  TreasuryBatchTraceEntry,
  TreasuryBatchTraceReport,
  TreasuryCloseIssue,
  TreasuryPeriodRollforwardReport,
} from '../types';
import { ReconciliationGateService, TradeReconciliationGate } from './reconciliationGate';

const PAGE_SIZE = 500;

function sumRaw(values: Iterable<string | null | undefined>): string {
  let total = 0n;
  for (const value of values) {
    if (!value) {
      continue;
    }
    total += BigInt(value);
  }
  return total.toString();
}

function entrySourceAmount(entry: LedgerEntryAccountingProjection): string {
  return entry.amount_raw;
}

function entryAllocatedAmount(entry: LedgerEntryAccountingProjection): string {
  return entry.allocated_amount_raw ?? entry.amount_raw;
}

function isWithinWindow(timestamp: Date | null | undefined, startsAt: Date, endsAt: Date): boolean {
  return Boolean(timestamp && timestamp >= startsAt && timestamp <= endsAt);
}

function dedupeIssues(issues: TreasuryCloseIssue[]): TreasuryCloseIssue[] {
  const byKey = new Map<string, TreasuryCloseIssue>();
  for (const issue of issues) {
    const key = [
      issue.code,
      issue.trade_id ?? '',
      issue.sweep_batch_id ?? '',
      issue.ledger_entry_id ?? '',
    ].join('|');
    if (!byKey.has(key)) {
      byKey.set(key, issue);
    }
  }
  return [...byKey.values()];
}

function buildEntryIssues(entry: LedgerEntryAccountingProjection): TreasuryCloseIssue[] {
  const issues: TreasuryCloseIssue[] = [];

  if (entry.accounting_state === 'EXCEPTION') {
    issues.push({
      code: 'ENTRY_EXCEPTION_STATE',
      severity: 'BLOCKING',
      owner: 'TREASURY',
      message: entry.accounting_state_reason,
      trade_id: entry.trade_id,
      sweep_batch_id: entry.sweep_batch_id,
      ledger_entry_id: entry.ledger_entry_id,
      details: {
        accountingState: entry.accounting_state,
        accountingStateReason: entry.accounting_state_reason,
      },
    });
  }

  if (entry.allocated_amount_raw !== null && entry.allocated_amount_raw !== entry.amount_raw) {
    issues.push({
      code: 'ALLOCATED_AMOUNT_DIFFERS_FROM_SOURCE',
      severity: 'WARNING',
      owner: 'FINANCE',
      message: 'Allocated amount differs from the source ledger amount',
      trade_id: entry.trade_id,
      sweep_batch_id: entry.sweep_batch_id,
      ledger_entry_id: entry.ledger_entry_id,
      details: {
        sourceAmountRaw: entry.amount_raw,
        allocatedAmountRaw: entry.allocated_amount_raw,
      },
    });
  }

  return issues;
}

function buildReconciliationIssues(
  assessments: Map<string, TradeReconciliationGate>,
): TreasuryCloseIssue[] {
  const issues: TreasuryCloseIssue[] = [];

  for (const [tradeId, assessment] of assessments.entries()) {
    if (assessment.status === 'CLEAR') {
      continue;
    }

    issues.push({
      code: `RECONCILIATION_${assessment.status}`,
      severity: 'BLOCKING',
      owner: 'RECONCILIATION',
      message:
        assessment.blockedReasons.join('; ') ||
        'Trade is not reconciliation-clear for treasury close',
      trade_id: tradeId,
      sweep_batch_id: null,
      ledger_entry_id: null,
      details: {
        reconciliationStatus: assessment.status,
        runKey: assessment.runKey,
        freshness: assessment.freshness,
        blockedReasons: assessment.blockedReasons,
        driftCount: assessment.driftCount,
      },
    });
  }

  return issues;
}

function serializeBatchTraceEntry(entry: LedgerEntryAccountingProjection): TreasuryBatchTraceEntry {
  return {
    ledger_entry_id: entry.ledger_entry_id,
    trade_id: entry.trade_id,
    component_type: entry.component_type,
    source_amount_raw: entry.amount_raw,
    allocated_amount_raw: entry.allocated_amount_raw,
    earned_at: entry.earned_at.toISOString(),
    accounting_state: entry.accounting_state,
    accounting_state_reason: entry.accounting_state_reason,
    matched_sweep_tx_hash: entry.matched_sweep_tx_hash,
    matched_swept_at: entry.matched_swept_at ? entry.matched_swept_at.toISOString() : null,
    partner_reference: entry.partner_reference,
    partner_handoff_status: entry.partner_handoff_status,
    latest_bank_reference: entry.latest_bank_reference ?? null,
    latest_bank_payout_state: entry.latest_bank_payout_state,
    latest_bank_confirmed_at: entry.latest_bank_confirmed_at
      ? entry.latest_bank_confirmed_at.toISOString()
      : null,
    revenue_realization_status: entry.revenue_realization_status,
    realized_at: entry.realized_at ? entry.realized_at.toISOString() : null,
  };
}

export function buildTreasuryBatchTraceReport(params: {
  batch: TreasuryBatchTraceReport['batch'];
  claimEvent: TreasuryBatchTraceReport['claim_event'];
  partnerHandoff: TreasuryBatchTraceReport['partner_handoff'];
  entries: LedgerEntryAccountingProjection[];
}): TreasuryBatchTraceReport {
  const entryIssues = params.entries.flatMap((entry) => buildEntryIssues(entry));
  const batchIssues: TreasuryCloseIssue[] = [];

  if (params.batch.status === 'EXECUTED' && !params.claimEvent) {
    batchIssues.push({
      code: 'SWEEP_TX_UNMATCHED',
      severity: 'BLOCKING',
      owner: 'TREASURY',
      message: 'Sweep batch is marked executed without matched treasury claim evidence',
      trade_id: null,
      sweep_batch_id: params.batch.id,
      ledger_entry_id: null,
      details: {
        batchStatus: params.batch.status,
      },
    });
  }

  if (params.batch.status === 'HANDED_OFF' && !params.partnerHandoff?.partner_reference) {
    batchIssues.push({
      code: 'EXTERNAL_HANDOFF_MISSING',
      severity: 'BLOCKING',
      owner: 'TREASURY',
      message: 'Sweep batch is marked handed off without an external handoff reference',
      trade_id: null,
      sweep_batch_id: params.batch.id,
      ledger_entry_id: null,
      details: {
        batchStatus: params.batch.status,
      },
    });
  }

  const blockingIssues = dedupeIssues(
    [...entryIssues, ...batchIssues].filter((issue) => issue.severity === 'BLOCKING'),
  );
  const warningIssues = dedupeIssues(
    [...entryIssues, ...batchIssues].filter((issue) => issue.severity === 'WARNING'),
  );

  return {
    batch: params.batch,
    claim_event: params.claimEvent,
    partner_handoff: params.partnerHandoff,
    totals: {
      expected_total_raw: params.batch.expected_total_raw,
      allocated_total_raw: sumRaw(params.entries.map((entry) => entryAllocatedAmount(entry))),
      entry_count: params.entries.length,
    },
    entries: params.entries.map((entry) => serializeBatchTraceEntry(entry)),
    blocking_issues: blockingIssues,
    warning_issues: warningIssues,
  };
}

export function buildTreasuryPeriodRollforwardReport(params: {
  period: AccountingPeriod;
  entries: LedgerEntryAccountingProjection[];
  reconciliationAssessments: Map<string, TradeReconciliationGate>;
  batchReports: TreasuryBatchTraceReport[];
  generatedAt?: Date;
}): TreasuryPeriodRollforwardReport {
  const { period, entries } = params;
  const startsAt = period.starts_at;
  const endsAt = period.ends_at;

  const entryIssues = entries.flatMap((entry) => buildEntryIssues(entry));
  const reconciliationIssues = buildReconciliationIssues(params.reconciliationAssessments);
  const openBatchIssues = params.batchReports
    .filter((batch) => !['CLOSED', 'VOID'].includes(batch.batch.status))
    .map<TreasuryCloseIssue>((batch) => ({
      code: 'BATCH_NOT_CLOSED',
      severity: 'BLOCKING',
      owner: 'TREASURY',
      message: 'Sweep batch remains open for the accounting period',
      trade_id: null,
      sweep_batch_id: batch.batch.id,
      ledger_entry_id: null,
      details: {
        batchStatus: batch.batch.status,
      },
    }));

  const allIssues = dedupeIssues([
    ...entryIssues,
    ...reconciliationIssues,
    ...openBatchIssues,
    ...params.batchReports.flatMap((batch) => [...batch.blocking_issues, ...batch.warning_issues]),
  ]);

  const openingHeldEntries = entries.filter(
    (entry) =>
      entry.earned_at < startsAt && (!entry.matched_swept_at || entry.matched_swept_at >= startsAt),
  );
  const newAccrualEntries = entries.filter((entry) =>
    isWithinWindow(entry.earned_at, startsAt, endsAt),
  );
  const allocatedEntries = entries.filter((entry) =>
    isWithinWindow(entry.allocated_at ?? null, startsAt, endsAt),
  );
  const sweptEntries = entries.filter((entry) =>
    isWithinWindow(entry.matched_swept_at ?? null, startsAt, endsAt),
  );
  const handedOffEntries = entries.filter((entry) =>
    isWithinWindow(
      entry.partner_submitted_at ??
        entry.partner_acknowledged_at ??
        entry.partner_completed_at ??
        entry.partner_failed_at ??
        null,
      startsAt,
      endsAt,
    ),
  );
  const realizedEntries = entries.filter((entry) =>
    isWithinWindow(entry.realized_at ?? null, startsAt, endsAt),
  );
  const endingHeldEntries = entries.filter(
    (entry) =>
      entry.earned_at <= endsAt && (!entry.matched_swept_at || entry.matched_swept_at > endsAt),
  );
  const unresolvedExceptions = entries.filter(
    (entry) =>
      entry.earned_at <= endsAt &&
      entry.accounting_state === 'EXCEPTION' &&
      entry.revenue_realization_status !== 'REALIZED',
  );

  const blockingIssues = allIssues.filter((issue) => issue.severity === 'BLOCKING');
  const warningIssues = allIssues.filter((issue) => issue.severity === 'WARNING');

  return {
    period,
    generated_at: (params.generatedAt ?? new Date()).toISOString(),
    opening_held_raw: sumRaw(openingHeldEntries.map((entry) => entrySourceAmount(entry))),
    new_accruals_raw: sumRaw(newAccrualEntries.map((entry) => entrySourceAmount(entry))),
    allocated_to_batches_raw: sumRaw(allocatedEntries.map((entry) => entryAllocatedAmount(entry))),
    swept_onchain_raw: sumRaw(
      sweptEntries.map((entry) => entry.matched_claim_amount_raw ?? entryAllocatedAmount(entry)),
    ),
    handed_off_raw: sumRaw(handedOffEntries.map((entry) => entryAllocatedAmount(entry))),
    realized_raw: sumRaw(realizedEntries.map((entry) => entryAllocatedAmount(entry))),
    ending_held_raw: sumRaw(endingHeldEntries.map((entry) => entrySourceAmount(entry))),
    unresolved_exception_raw: sumRaw(
      unresolvedExceptions.map((entry) => entryAllocatedAmount(entry)),
    ),
    blocking_issue_count: blockingIssues.length,
    warning_issue_count: warningIssues.length,
    blocking_issues: blockingIssues,
    warning_issues: warningIssues,
  };
}

async function loadAllAccountingEntriesUpTo(
  endsAt: Date,
): Promise<LedgerEntryAccountingProjection[]> {
  const rows: LedgerEntryAccountingProjection[] = [];
  let offset = 0;

  for (;;) {
    const page = await listLedgerEntryAccountingProjections({
      limit: PAGE_SIZE,
      offset,
    });
    if (page.length === 0) {
      break;
    }

    rows.push(...page.filter((entry) => entry.earned_at <= endsAt));

    if (page.length < PAGE_SIZE) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return rows;
}

async function loadAllSweepBatchesForPeriod(periodId: number) {
  const rows: SweepBatchWithPeriod[] = [];
  let offset = 0;

  for (;;) {
    const page = await listSweepBatches({
      accountingPeriodId: periodId,
      limit: PAGE_SIZE,
      offset,
    });
    if (page.length === 0) {
      break;
    }

    rows.push(...page);

    if (page.length < PAGE_SIZE) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return rows;
}

export async function loadTreasuryBatchTraceReport(
  batchId: number,
): Promise<TreasuryBatchTraceReport> {
  const detail = await getSweepBatchDetail(batchId);
  if (!detail) {
    throw new Error('Sweep batch not found');
  }

  const claimEvent = await getTreasuryClaimEventByBatchId(batchId);

  return buildTreasuryBatchTraceReport({
    batch: detail.batch,
    claimEvent,
    partnerHandoff: detail.partnerHandoff,
    entries: detail.entries,
  });
}

export async function loadTreasuryAccountingPeriodClosePacket(
  periodId: number,
  reconciliationGate: ReconciliationGateService,
): Promise<TreasuryAccountingPeriodClosePacket> {
  const period = await getAccountingPeriodById(periodId);
  if (!period) {
    throw new Error('Accounting period not found');
  }

  const [entries, batches] = await Promise.all([
    loadAllAccountingEntriesUpTo(period.ends_at),
    loadAllSweepBatchesForPeriod(periodId),
  ]);

  const batchReports = await Promise.all(
    batches.map((batch) => loadTreasuryBatchTraceReport(batch.id)),
  );

  const tradeIds = Array.from(
    new Set(batchReports.flatMap((batch) => batch.entries.map((entry) => entry.trade_id))),
  ).sort((a, b) => a.localeCompare(b));

  const [reconciliationAssessments, reconciliationSummary] = await Promise.all([
    reconciliationGate.assessTrades(tradeIds),
    reconciliationGate.summarizeTrades(tradeIds),
  ]);

  const rollforward = buildTreasuryPeriodRollforwardReport({
    period,
    entries,
    reconciliationAssessments,
    batchReports,
  });

  const blockingIssues = dedupeIssues([
    ...rollforward.blocking_issues,
    ...(reconciliationSummary.status !== 'CLEAR'
      ? [
          {
            code: `PERIOD_RECONCILIATION_${reconciliationSummary.status}`,
            severity: 'BLOCKING',
            owner: 'RECONCILIATION',
            message:
              reconciliationSummary.blockedReasons.join('; ') ||
              'Accounting period is not reconciliation-clear',
            trade_id: null,
            sweep_batch_id: null,
            ledger_entry_id: null,
            details: {
              reconciliationStatus: reconciliationSummary.status,
              freshness: reconciliationSummary.freshness,
              latestCompletedRunKey: reconciliationSummary.latestCompletedRunKey,
            },
          } satisfies TreasuryCloseIssue,
        ]
      : []),
  ]);
  const warningIssues = dedupeIssues([
    ...rollforward.warning_issues,
    ...batchReports.flatMap((batch) => batch.warning_issues),
  ]);

  return {
    period,
    generated_at: new Date().toISOString(),
    ready_for_close: blockingIssues.length === 0,
    rollforward,
    reconciliation: {
      status: reconciliationSummary.status,
      freshness: reconciliationSummary.freshness,
      latest_completed_run_key: reconciliationSummary.latestCompletedRunKey,
      latest_completed_run_at: reconciliationSummary.latestCompletedRunAt
        ? reconciliationSummary.latestCompletedRunAt.toISOString()
        : null,
      stale_running_run_count: reconciliationSummary.staleRunningRunCount,
      blocked_reasons: reconciliationSummary.blockedReasons,
    },
    batches: batchReports,
    blocking_issues: blockingIssues,
    warning_issues: warningIssues,
  };
}

export function renderTreasuryAccountingPeriodClosePacketMarkdown(
  packet: TreasuryAccountingPeriodClosePacket,
): string {
  const lines: string[] = [];

  lines.push(`# Treasury Close Packet: ${packet.period.period_key}`);
  lines.push('');
  lines.push(`- Generated at: ${packet.generated_at}`);
  lines.push(`- Ready for close: ${packet.ready_for_close ? 'yes' : 'no'}`);
  lines.push(`- Reconciliation status: ${packet.reconciliation.status}`);
  lines.push(`- Reconciliation freshness: ${packet.reconciliation.freshness}`);
  lines.push('');
  lines.push('## Rollforward');
  lines.push('');
  lines.push(`- Opening held: ${packet.rollforward.opening_held_raw}`);
  lines.push(`- New accruals: ${packet.rollforward.new_accruals_raw}`);
  lines.push(`- Allocated to batches: ${packet.rollforward.allocated_to_batches_raw}`);
  lines.push(`- Swept on-chain: ${packet.rollforward.swept_onchain_raw}`);
  lines.push(`- Handed off externally: ${packet.rollforward.handed_off_raw}`);
  lines.push(`- Realized: ${packet.rollforward.realized_raw}`);
  lines.push(`- Ending held: ${packet.rollforward.ending_held_raw}`);
  lines.push(`- Unresolved exceptions: ${packet.rollforward.unresolved_exception_raw}`);
  lines.push('');
  lines.push('## Blocking Issues');
  lines.push('');

  if (packet.blocking_issues.length === 0) {
    lines.push('- None');
  } else {
    for (const issue of packet.blocking_issues) {
      lines.push(
        `- [${issue.owner}] ${issue.code}: ${issue.message}${
          issue.trade_id ? ` (trade ${issue.trade_id})` : ''
        }${issue.sweep_batch_id ? ` (batch ${issue.sweep_batch_id})` : ''}${
          issue.ledger_entry_id ? ` (entry ${issue.ledger_entry_id})` : ''
        }`,
      );
    }
  }

  lines.push('');
  lines.push('## Warning Issues');
  lines.push('');

  if (packet.warning_issues.length === 0) {
    lines.push('- None');
  } else {
    for (const issue of packet.warning_issues) {
      lines.push(
        `- [${issue.owner}] ${issue.code}: ${issue.message}${
          issue.trade_id ? ` (trade ${issue.trade_id})` : ''
        }${issue.sweep_batch_id ? ` (batch ${issue.sweep_batch_id})` : ''}${
          issue.ledger_entry_id ? ` (entry ${issue.ledger_entry_id})` : ''
        }`,
      );
    }
  }

  lines.push('');
  lines.push('## Batches');
  lines.push('');

  if (packet.batches.length === 0) {
    lines.push('- No sweep batches are linked to this accounting period.');
  } else {
    for (const batch of packet.batches) {
      lines.push(
        `- Batch ${batch.batch.batch_key} (${batch.batch.status}): expected ${batch.totals.expected_total_raw}, allocated ${batch.totals.allocated_total_raw}, entries ${batch.totals.entry_count}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
