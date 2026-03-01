import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReconciliationReport, buildReconciliationReportRows, RECONCILIATION_REPORT_VERSION } from '../core/reconciliationReport';

test('reconciliation report rows are deterministically ordered and keep stable schema fields', () => {
  const rows = buildReconciliationReportRows([
    {
      tradeId: '10',
      txHash: '0xbb',
      extrinsicHash: null,
      payoutState: 'PENDING_REVIEW',
      mismatchCodes: ['STATUS_MISMATCH', 'STATUS_MISMATCH', 'HASH_MISMATCH'],
      ledgerEntryId: 4,
    },
    {
      tradeId: '2',
      txHash: null,
      extrinsicHash: null,
      payoutState: null,
      mismatchCodes: ['ONCHAIN_READ_ERROR'],
      ledgerEntryId: null,
    },
    {
      tradeId: '10',
      txHash: '0xaa',
      extrinsicHash: null,
      payoutState: 'PAID',
      mismatchCodes: [],
      ledgerEntryId: 1,
    },
  ]);

  assert.deepEqual(rows, [
    {
      tradeId: '2',
      txHash: null,
      extrinsicHash: null,
      payoutState: null,
      reconciliationVerdict: 'MISMATCH',
      mismatchReason: 'ONCHAIN_READ_ERROR',
    },
    {
      tradeId: '10',
      txHash: '0xaa',
      extrinsicHash: null,
      payoutState: 'PAID',
      reconciliationVerdict: 'MATCH',
      mismatchReason: null,
    },
    {
      tradeId: '10',
      txHash: '0xbb',
      extrinsicHash: null,
      payoutState: 'PENDING_REVIEW',
      reconciliationVerdict: 'MISMATCH',
      mismatchReason: 'HASH_MISMATCH,STATUS_MISMATCH',
    },
  ]);
});

test('reconciliation report summary counts are stable', () => {
  const report = buildReconciliationReport('once-2026-03-01T00:00:00.000Z', [
    {
      tradeId: '1',
      txHash: '0xabc',
      extrinsicHash: null,
      payoutState: 'PAID',
      mismatchCodes: [],
      ledgerEntryId: 1,
    },
    {
      tradeId: '2',
      txHash: null,
      extrinsicHash: null,
      payoutState: null,
      mismatchCodes: ['AMOUNT_MISMATCH'],
      ledgerEntryId: null,
    },
  ]);

  assert.equal(report.reportVersion, RECONCILIATION_REPORT_VERSION);
  assert.equal(report.runKey, 'once-2026-03-01T00:00:00.000Z');
  assert.equal(report.summary.rowCount, 2);
  assert.equal(report.summary.matchCount, 1);
  assert.equal(report.summary.mismatchCount, 1);
});
