export const RECONCILIATION_REPORT_VERSION = '1.0';

export type ReconciliationVerdict = 'MATCH' | 'MISMATCH';

export interface ReconciliationReportInputRow {
  tradeId: string;
  txHash: string | null;
  extrinsicHash: string | null;
  payoutState: string | null;
  mismatchCodes: string[];
  ledgerEntryId: number | null;
}

export interface ReconciliationReportRow {
  tradeId: string;
  txHash: string | null;
  extrinsicHash: string | null;
  payoutState: string | null;
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

export function buildReconciliationReportRows(inputRows: ReconciliationReportInputRow[]): ReconciliationReportRow[] {
  const rows = inputRows.map((row) => {
    const uniqueMismatchCodes = Array.from(new Set(row.mismatchCodes)).sort((a, b) => a.localeCompare(b));
    const mismatchReason = uniqueMismatchCodes.length > 0 ? uniqueMismatchCodes.join(',') : null;
    const reconciliationVerdict: ReconciliationVerdict = uniqueMismatchCodes.length > 0 ? 'MISMATCH' : 'MATCH';

    return {
      tradeId: row.tradeId,
      txHash: row.txHash,
      extrinsicHash: row.extrinsicHash,
      payoutState: row.payoutState,
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

    const aLedgerEntry = a._ledgerEntryId ?? Number.MAX_SAFE_INTEGER;
    const bLedgerEntry = b._ledgerEntryId ?? Number.MAX_SAFE_INTEGER;
    return aLedgerEntry - bLedgerEntry;
  });

  return rows.map(({ _ledgerEntryId: _unused, ...row }) => row);
}

export function buildReconciliationReport(runKey: string | null, inputRows: ReconciliationReportInputRow[]): ReconciliationReport {
  const rows = buildReconciliationReportRows(inputRows);
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
