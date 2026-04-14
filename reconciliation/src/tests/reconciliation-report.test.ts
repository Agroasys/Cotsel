import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReconciliationReport,
  buildReconciliationReportRows,
  RECONCILIATION_REPORT_VERSION,
} from '../core/reconciliationReport';

test('reconciliation report rows are deterministically ordered and keep stable schema fields', () => {
  const rows = buildReconciliationReportRows(
    [
      {
        tradeId: '10',
        txHash: '0xbb',
        payoutState: 'PENDING_REVIEW',
        rampReference: 'ramp-b',
        fiatDepositState: 'PARTIAL',
        fiatDepositFailureClass: 'PARTIAL_FUNDING',
        fiatDepositObservedAt: new Date('2026-03-25T00:00:00.000Z'),
        bankReference: 'bank-b',
        bankPayoutState: 'CONFIRMED',
        bankFailureCode: null,
        bankConfirmedAt: new Date('2026-03-25T02:00:00.000Z'),
        mismatchCodes: ['STATUS_MISMATCH', 'STATUS_MISMATCH', 'HASH_MISMATCH'],
        ledgerEntryId: 4,
      },
      {
        tradeId: '2',
        txHash: null,
        payoutState: null,
        rampReference: 'ramp-a',
        fiatDepositState: 'PENDING',
        fiatDepositFailureClass: null,
        fiatDepositObservedAt: new Date('2026-03-24T00:00:00.000Z'),
        bankReference: null,
        bankPayoutState: null,
        bankFailureCode: null,
        bankConfirmedAt: null,
        mismatchCodes: ['ONCHAIN_READ_ERROR'],
        ledgerEntryId: null,
      },
      {
        tradeId: '10',
        txHash: '0xaa',
        payoutState: 'PARTNER_REPORTED_COMPLETED',
        rampReference: 'ramp-a',
        fiatDepositState: 'FUNDED',
        fiatDepositFailureClass: null,
        fiatDepositObservedAt: new Date('2026-03-26T00:00:00.000Z'),
        bankReference: 'bank-a',
        bankPayoutState: 'PENDING',
        bankFailureCode: null,
        bankConfirmedAt: new Date('2026-03-26T04:00:00.000Z'),
        mismatchCodes: [],
        ledgerEntryId: 1,
      },
    ],
    { now: new Date('2026-03-26T12:00:00.000Z') },
  );

  assert.deepEqual(rows, [
    {
      tradeId: '2',
      txHash: null,
      payoutState: null,
      rampReference: 'ramp-a',
      fiatDepositState: 'PENDING',
      fiatDepositFailureReason: null,
      fiatDepositObservedAt: '2026-03-24T00:00:00.000Z',
      bankReference: null,
      bankPayoutState: null,
      bankFailureCode: null,
      bankConfirmedAt: null,
      bankPayoutDivergenceReason: null,
      reconciliationVerdict: 'MISMATCH',
      mismatchReason: 'ONCHAIN_READ_ERROR,STALE_PENDING_DEPOSIT',
    },
    {
      tradeId: '10',
      txHash: '0xaa',
      payoutState: 'PARTNER_REPORTED_COMPLETED',
      rampReference: 'ramp-a',
      fiatDepositState: 'FUNDED',
      fiatDepositFailureReason: null,
      fiatDepositObservedAt: '2026-03-26T00:00:00.000Z',
      bankReference: 'bank-a',
      bankPayoutState: 'PENDING',
      bankFailureCode: null,
      bankConfirmedAt: '2026-03-26T04:00:00.000Z',
      bankPayoutDivergenceReason: 'TREASURY_BANK_STATE_DIVERGENCE',
      reconciliationVerdict: 'MISMATCH',
      mismatchReason: 'TREASURY_BANK_STATE_DIVERGENCE',
    },
    {
      tradeId: '10',
      txHash: '0xbb',
      payoutState: 'PENDING_REVIEW',
      rampReference: 'ramp-b',
      fiatDepositState: 'PARTIAL',
      fiatDepositFailureReason: 'PARTIAL_FUNDING',
      fiatDepositObservedAt: '2026-03-25T00:00:00.000Z',
      bankReference: 'bank-b',
      bankPayoutState: 'CONFIRMED',
      bankFailureCode: null,
      bankConfirmedAt: '2026-03-25T02:00:00.000Z',
      bankPayoutDivergenceReason: 'TREASURY_BANK_STATE_DIVERGENCE',
      reconciliationVerdict: 'MISMATCH',
      mismatchReason:
        'HASH_MISMATCH,PARTIAL_FUNDING,STATUS_MISMATCH,TREASURY_BANK_STATE_DIVERGENCE',
    },
  ]);
});

test('reconciliation report summary counts are stable', () => {
  const report = buildReconciliationReport('once-2026-03-01T00:00:00.000Z', [
    {
      tradeId: '1',
      txHash: '0xabc',
      payoutState: 'PARTNER_REPORTED_COMPLETED',
      rampReference: 'ramp-1',
      fiatDepositState: 'FUNDED',
      fiatDepositFailureClass: null,
      fiatDepositObservedAt: new Date('2026-03-01T00:00:00.000Z'),
      bankReference: 'bank-1',
      bankPayoutState: 'CONFIRMED',
      bankFailureCode: null,
      bankConfirmedAt: new Date('2026-03-01T01:00:00.000Z'),
      mismatchCodes: [],
      ledgerEntryId: 1,
    },
    {
      tradeId: '2',
      txHash: null,
      payoutState: null,
      rampReference: null,
      fiatDepositState: null,
      fiatDepositFailureClass: null,
      fiatDepositObservedAt: null,
      bankReference: null,
      bankPayoutState: null,
      bankFailureCode: null,
      bankConfirmedAt: null,
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
