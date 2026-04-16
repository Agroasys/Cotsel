export const RECONCILIATION_REPORT_VERSION = '2.0';

export type ReconciliationVerdict = 'MATCH' | 'MISMATCH';

export interface ReconciliationReportInputRow {
  tradeId: string;
  txHash: string | null;
  payoutState: string | null;
  sourceAmountRaw?: string | null;
  allocatedAmountRaw?: string | null;
  accountingState: string | null;
  accountingStateReason: string | null;
  accountingPeriodKey: string | null;
  accountingPeriodStatus: string | null;
  sweepBatchId: number | null;
  sweepBatchStatus: string | null;
  matchedSweepTxHash: string | null;
  matchedSweptAt: Date | null;
  partnerName: string | null;
  partnerReference: string | null;
  partnerHandoffStatus: string | null;
  realizedAt: Date | null;
  rampReference: string | null;
  fiatDepositState: string | null;
  fiatDepositFailureClass: string | null;
  fiatDepositObservedAt: Date | null;
  bankReference: string | null;
  bankPayoutState: string | null;
  bankFailureCode: string | null;
  bankConfirmedAt: Date | null;
  mismatchCodes: string[];
  ledgerEntryId: number | null;
}

export interface ReconciliationReportRow {
  tradeId: string;
  txHash: string | null;
  payoutState: string | null;
  accountingState: string | null;
  accountingStateReason: string | null;
  accountingPeriodKey: string | null;
  accountingPeriodStatus: string | null;
  sweepBatchId: number | null;
  sweepBatchStatus: string | null;
  matchedSweepTxHash: string | null;
  matchedSweptAt: string | null;
  partnerName: string | null;
  partnerReference: string | null;
  partnerHandoffStatus: string | null;
  realizedAt: string | null;
  rampReference: string | null;
  fiatDepositState: string | null;
  fiatDepositFailureReason: string | null;
  fiatDepositObservedAt: string | null;
  bankReference: string | null;
  bankPayoutState: string | null;
  bankFailureCode: string | null;
  bankConfirmedAt: string | null;
  bankPayoutDivergenceReason: string | null;
  reconciliationVerdict: ReconciliationVerdict;
  mismatchReason: string | null;
}

export interface ReconciliationReport {
  reportVersion: string;
  runKey: string | null;
  rows: ReconciliationReportRow[];
  summary: {
    rowCount: number;
    matchCount: number;
    mismatchCount: number;
  };
}

export interface ReconciliationReportBuildOptions {
  now?: Date;
  stalePendingAfterHours?: number;
}

const TERMINAL_EXTERNAL_EXECUTION_STATE = 'EXTERNAL_EXECUTION_CONFIRMED';

function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return a.localeCompare(b);
}

function compareTradeIds(a: string, b: string): number {
  if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) {
    const aInt = BigInt(a);
    const bInt = BigInt(b);
    if (aInt === bInt) {
      return 0;
    }
    return aInt < bInt ? -1 : 1;
  }

  return a.localeCompare(b);
}

function deriveMismatchCodes(
  row: ReconciliationReportInputRow,
  options: ReconciliationReportBuildOptions,
): string[] {
  const mismatchCodes = [...row.mismatchCodes];

  if (row.fiatDepositFailureClass) {
    mismatchCodes.push(row.fiatDepositFailureClass);
  }

  const now = options.now ?? new Date();
  const stalePendingAfterHours = options.stalePendingAfterHours ?? 24;
  if (
    row.fiatDepositState === 'PENDING' &&
    row.fiatDepositObservedAt &&
    now.getTime() - row.fiatDepositObservedAt.getTime() >= stalePendingAfterHours * 60 * 60 * 1000
  ) {
    mismatchCodes.push('STALE_PENDING_DEPOSIT');
  }

  if (row.bankPayoutState === 'REJECTED') {
    mismatchCodes.push('BANK_REJECTED');
    if (row.payoutState !== 'CANCELLED') {
      mismatchCodes.push('TREASURY_BANK_STATE_DIVERGENCE');
    }
  }

  if (
    row.bankPayoutState === 'CONFIRMED' &&
    row.payoutState !== TERMINAL_EXTERNAL_EXECUTION_STATE
  ) {
    mismatchCodes.push('TREASURY_BANK_STATE_DIVERGENCE');
  }

  if (row.bankPayoutState === 'PENDING' && row.payoutState === TERMINAL_EXTERNAL_EXECUTION_STATE) {
    mismatchCodes.push('TREASURY_BANK_STATE_DIVERGENCE');
  }

  if (row.sweepBatchStatus === 'EXECUTED' && !row.matchedSweepTxHash) {
    mismatchCodes.push('SWEEP_TX_UNMATCHED');
  }

  if (row.sweepBatchStatus === 'HANDED_OFF' && !row.partnerReference) {
    mismatchCodes.push('PARTNER_HANDOFF_MISSING');
  }

  if (row.realizedAt && row.partnerHandoffStatus !== 'COMPLETED') {
    mismatchCodes.push('REALIZATION_WITHOUT_CONFIRMATION');
  }

  if (
    row.allocatedAmountRaw !== undefined &&
    row.allocatedAmountRaw !== null &&
    row.sourceAmountRaw !== undefined &&
    row.sourceAmountRaw !== null &&
    row.allocatedAmountRaw !== row.sourceAmountRaw
  ) {
    mismatchCodes.push('ALLOCATED_AMOUNT_DIFFERS_FROM_SOURCE');
  }

  return Array.from(new Set(mismatchCodes)).sort((a, b) => a.localeCompare(b));
}

export function buildReconciliationReportRows(
  inputRows: ReconciliationReportInputRow[],
  options: ReconciliationReportBuildOptions = {},
): ReconciliationReportRow[] {
  const rows = inputRows.map((row) => {
    const uniqueMismatchCodes = deriveMismatchCodes(row, options);
    const mismatchReason = uniqueMismatchCodes.length > 0 ? uniqueMismatchCodes.join(',') : null;
    const reconciliationVerdict: ReconciliationVerdict =
      uniqueMismatchCodes.length > 0 ? 'MISMATCH' : 'MATCH';
    const bankMismatchCodes = uniqueMismatchCodes.filter(
      (code) => code === 'BANK_REJECTED' || code === 'TREASURY_BANK_STATE_DIVERGENCE',
    );

    return {
      tradeId: row.tradeId,
      txHash: row.txHash,
      payoutState: row.payoutState,
      accountingState: row.accountingState,
      accountingStateReason: row.accountingStateReason,
      accountingPeriodKey: row.accountingPeriodKey,
      accountingPeriodStatus: row.accountingPeriodStatus,
      sweepBatchId: row.sweepBatchId,
      sweepBatchStatus: row.sweepBatchStatus,
      matchedSweepTxHash: row.matchedSweepTxHash,
      matchedSweptAt: row.matchedSweptAt ? row.matchedSweptAt.toISOString() : null,
      partnerName: row.partnerName,
      partnerReference: row.partnerReference,
      partnerHandoffStatus: row.partnerHandoffStatus,
      realizedAt: row.realizedAt ? row.realizedAt.toISOString() : null,
      rampReference: row.rampReference,
      fiatDepositState: row.fiatDepositState,
      fiatDepositFailureReason: row.fiatDepositFailureClass,
      fiatDepositObservedAt: row.fiatDepositObservedAt
        ? row.fiatDepositObservedAt.toISOString()
        : null,
      bankReference: row.bankReference,
      bankPayoutState: row.bankPayoutState,
      bankFailureCode: row.bankFailureCode,
      bankConfirmedAt: row.bankConfirmedAt ? row.bankConfirmedAt.toISOString() : null,
      bankPayoutDivergenceReason: bankMismatchCodes.length > 0 ? bankMismatchCodes.join(',') : null,
      reconciliationVerdict,
      mismatchReason,
      _ledgerEntryId: row.ledgerEntryId,
    };
  });

  rows.sort((a, b) => {
    const byTrade = compareTradeIds(a.tradeId, b.tradeId);
    if (byTrade !== 0) {
      return byTrade;
    }

    const byTx = compareNullableStrings(a.txHash, b.txHash);
    if (byTx !== 0) {
      return byTx;
    }

    const byState = compareNullableStrings(a.payoutState, b.payoutState);
    if (byState !== 0) {
      return byState;
    }

    const byRamp = compareNullableStrings(a.rampReference, b.rampReference);
    if (byRamp !== 0) {
      return byRamp;
    }

    const aLedgerEntry = a._ledgerEntryId ?? Number.MAX_SAFE_INTEGER;
    const bLedgerEntry = b._ledgerEntryId ?? Number.MAX_SAFE_INTEGER;
    return aLedgerEntry - bLedgerEntry;
  });

  return rows.map(({ _ledgerEntryId: _unused, ...row }) => row);
}

export function buildReconciliationReport(
  runKey: string | null,
  inputRows: ReconciliationReportInputRow[],
  options: ReconciliationReportBuildOptions = {},
): ReconciliationReport {
  const rows = buildReconciliationReportRows(inputRows, options);
  const matchCount = rows.filter((row) => row.reconciliationVerdict === 'MATCH').length;
  const mismatchCount = rows.length - matchCount;

  return {
    reportVersion: RECONCILIATION_REPORT_VERSION,
    runKey,
    rows,
    summary: {
      rowCount: rows.length,
      matchCount,
      mismatchCount,
    },
  };
}
