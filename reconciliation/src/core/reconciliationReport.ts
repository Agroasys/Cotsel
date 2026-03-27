export const RECONCILIATION_REPORT_VERSION = '1.2';

export type ReconciliationVerdict = 'MATCH' | 'MISMATCH';

export interface ReconciliationReportInputRow {
  tradeId: string;
  txHash: string | null;
  extrinsicHash: string | null;
  payoutState: string | null;
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
  extrinsicHash: string | null;
  payoutState: string | null;
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

function deriveMismatchCodes(row: ReconciliationReportInputRow, options: ReconciliationReportBuildOptions): string[] {
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
    row.payoutState !== 'PAID'
  ) {
    mismatchCodes.push('TREASURY_BANK_STATE_DIVERGENCE');
  }

  if (
    row.bankPayoutState === 'PENDING' &&
    row.payoutState === 'PAID'
  ) {
    mismatchCodes.push('TREASURY_BANK_STATE_DIVERGENCE');
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
    const reconciliationVerdict: ReconciliationVerdict = uniqueMismatchCodes.length > 0 ? 'MISMATCH' : 'MATCH';
    const bankMismatchCodes = uniqueMismatchCodes.filter((code) =>
      code === 'BANK_REJECTED' || code === 'TREASURY_BANK_STATE_DIVERGENCE',
    );

    return {
      tradeId: row.tradeId,
      txHash: row.txHash,
      extrinsicHash: row.extrinsicHash,
      payoutState: row.payoutState,
      rampReference: row.rampReference,
      fiatDepositState: row.fiatDepositState,
      fiatDepositFailureReason: row.fiatDepositFailureClass,
      fiatDepositObservedAt: row.fiatDepositObservedAt ? row.fiatDepositObservedAt.toISOString() : null,
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

    const byExtrinsic = compareNullableStrings(a.extrinsicHash, b.extrinsicHash);
    if (byExtrinsic !== 0) {
      return byExtrinsic;
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
