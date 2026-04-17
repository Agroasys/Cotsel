process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

jest.mock('../src/database/queries', () => ({
  getAccountingPeriodById: jest.fn(),
  getSweepBatchDetail: jest.fn(),
  getTreasuryClaimEventByBatchId: jest.fn(),
  listLedgerEntryAccountingProjections: jest.fn(),
  listSweepBatches: jest.fn(),
}));

import {
  buildTreasuryBatchTraceReport,
  buildTreasuryPeriodRollforwardReport,
  loadTreasuryAccountingPeriodClosePacket,
} from '../src/core/closeReporting';
import * as queries from '../src/database/queries';
import {
  AccountingPeriod,
  LedgerEntryAccountingProjection,
  SweepBatchWithPeriod,
  TreasuryClaimEvent,
} from '../src/types';

function makePeriod(overrides: Partial<AccountingPeriod> = {}): AccountingPeriod {
  return {
    id: 7,
    period_key: '2026-Q1',
    starts_at: new Date('2026-01-01T00:00:00.000Z'),
    ends_at: new Date('2026-03-31T23:59:59.000Z'),
    status: 'PENDING_CLOSE',
    created_by: 'user:treasury-preparer',
    close_reason: null,
    pending_close_at: new Date('2026-03-31T22:00:00.000Z'),
    closed_at: null,
    closed_by: null,
    metadata: {},
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-03-31T22:00:00.000Z'),
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<LedgerEntryAccountingProjection> = {},
): LedgerEntryAccountingProjection {
  return {
    ledger_entry_id: 501,
    trade_id: 'trade-501',
    component_type: 'PLATFORM_FEE',
    amount_raw: '100',
    allocated_amount_raw: null,
    allocated_at: null,
    earned_at: new Date('2026-03-15T10:00:00.000Z'),
    payout_state: 'PENDING_REVIEW',
    accounting_period_id: 7,
    accounting_period_key: '2026-Q1',
    accounting_period_status: 'PENDING_CLOSE',
    sweep_batch_id: null,
    sweep_batch_status: null,
    allocation_status: null,
    matched_sweep_tx_hash: null,
    matched_sweep_block_number: null,
    matched_swept_at: null,
    matched_treasury_identity: null,
    matched_payout_receiver: null,
    matched_claim_amount_raw: null,
    partner_handoff_id: null,
    partner_name: null,
    partner_reference: null,
    partner_handoff_status: null,
    partner_submitted_at: null,
    partner_acknowledged_at: null,
    partner_completed_at: null,
    partner_failed_at: null,
    partner_verified_at: null,
    latest_fiat_deposit_ramp_reference: null,
    latest_fiat_deposit_state: null,
    latest_fiat_deposit_failure_class: null,
    latest_fiat_deposit_observed_at: null,
    latest_bank_reference: null,
    latest_bank_payout_state: null,
    latest_bank_failure_code: null,
    latest_bank_confirmed_at: null,
    revenue_realization_status: null,
    realized_at: null,
    accounting_state: 'HELD',
    accounting_state_reason: 'Fee is earned and still held in treasury',
    ...overrides,
  };
}

function makeBatch(overrides: Partial<SweepBatchWithPeriod> = {}): SweepBatchWithPeriod {
  return {
    id: 11,
    batch_key: 'batch-q1-001',
    accounting_period_id: 7,
    accounting_period_key: '2026-Q1',
    accounting_period_status: 'PENDING_CLOSE',
    asset_symbol: 'USDC',
    status: 'CLOSED',
    expected_total_raw: '100',
    payout_receiver_address: '0xpayout',
    approval_requested_at: new Date('2026-03-20T12:00:00.000Z'),
    approval_requested_by: 'user:treasury-preparer',
    approved_at: new Date('2026-03-21T12:00:00.000Z'),
    approved_by: 'user:treasury-approver',
    matched_sweep_tx_hash: '0xclaim',
    matched_sweep_block_number: '101',
    matched_swept_at: new Date('2026-03-22T12:00:00.000Z'),
    executed_by: 'user:treasury-executor',
    closed_at: new Date('2026-03-23T12:00:00.000Z'),
    closed_by: 'user:treasury-closer',
    created_by: 'user:treasury-preparer',
    metadata: {},
    created_at: new Date('2026-03-20T10:00:00.000Z'),
    updated_at: new Date('2026-03-23T12:00:00.000Z'),
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TreasuryClaimEvent> = {}): TreasuryClaimEvent {
  return {
    id: 9,
    source_event_id: 'claim-9',
    matched_sweep_batch_id: 11,
    tx_hash: '0xclaim',
    block_number: 101,
    observed_at: new Date('2026-03-22T12:00:00.000Z'),
    treasury_identity: '0xtreasury',
    payout_receiver: '0xpayout',
    amount_raw: '100',
    triggered_by: '0xoperator',
    created_at: new Date('2026-03-22T12:00:00.000Z'),
    ...overrides,
  };
}

describe('treasury close reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('period rollforward math is derived deterministically from persisted accounting facts', () => {
    const period = makePeriod();
    const entries = [
      makeEntry({
        ledger_entry_id: 1,
        trade_id: 'trade-opening',
        amount_raw: '70',
        earned_at: new Date('2025-12-20T10:00:00.000Z'),
        accounting_state: 'HELD',
      }),
      makeEntry({
        ledger_entry_id: 2,
        trade_id: 'trade-swept',
        amount_raw: '100',
        allocated_amount_raw: '100',
        allocated_at: new Date('2026-03-20T10:00:00.000Z'),
        matched_swept_at: new Date('2026-03-22T10:00:00.000Z'),
        matched_claim_amount_raw: '100',
        accounting_state: 'SWEPT',
        accounting_state_reason: 'Matched on-chain treasury claim recorded',
      }),
      makeEntry({
        ledger_entry_id: 3,
        trade_id: 'trade-realized',
        amount_raw: '50',
        allocated_amount_raw: '50',
        allocated_at: new Date('2026-03-20T11:00:00.000Z'),
        matched_swept_at: new Date('2026-03-21T11:00:00.000Z'),
        matched_claim_amount_raw: '50',
        partner_submitted_at: new Date('2026-03-24T09:00:00.000Z'),
        partner_reference: 'handoff-3',
        partner_handoff_status: 'COMPLETED',
        latest_bank_reference: 'bank-3',
        latest_bank_payout_state: 'CONFIRMED',
        latest_bank_confirmed_at: new Date('2026-03-26T09:00:00.000Z'),
        revenue_realization_status: 'REALIZED',
        realized_at: new Date('2026-03-27T09:00:00.000Z'),
        accounting_state: 'REALIZED',
        accounting_state_reason: 'Controlled revenue realization recorded',
      }),
      makeEntry({
        ledger_entry_id: 4,
        trade_id: 'trade-exception',
        amount_raw: '20',
        accounting_state: 'EXCEPTION',
        accounting_state_reason: 'External handoff reported failure',
      }),
    ];

    const report = buildTreasuryPeriodRollforwardReport({
      period,
      entries,
      reconciliationAssessments: new Map([
        [
          'trade-opening',
          {
            tradeId: 'trade-opening',
            status: 'CLEAR',
            freshness: 'FRESH',
            runKey: 'run-1',
            completedAt: new Date('2026-03-31T23:00:00.000Z'),
            staleRunningRunCount: 0,
            blockedReasons: [],
            driftCount: 0,
          },
        ],
      ]),
      batchReports: [],
      generatedAt: new Date('2026-03-31T23:59:59.000Z'),
    });

    expect(report.opening_held_raw).toBe('70');
    expect(report.new_accruals_raw).toBe('170');
    expect(report.allocated_to_batches_raw).toBe('150');
    expect(report.swept_onchain_raw).toBe('150');
    expect(report.handed_off_raw).toBe('50');
    expect(report.realized_raw).toBe('50');
    expect(report.ending_held_raw).toBe('90');
    expect(report.unresolved_exception_raw).toBe('20');
    expect(report.blocking_issues.map((issue) => issue.code)).toContain('ENTRY_EXCEPTION_STATE');
  });

  test('batch trace report includes on-chain claim and external handoff linkage', () => {
    const report = buildTreasuryBatchTraceReport({
      batch: makeBatch(),
      claimEvent: makeClaim(),
      partnerHandoff: {
        id: 33,
        sweep_batch_id: 11,
        partner_name: 'licensed-counterparty',
        partner_reference: 'handoff-33',
        handoff_status: 'ACKNOWLEDGED',
        latest_payload_hash: 'payload-hash',
        evidence_reference: 'evidence://handoff-33',
        submitted_at: new Date('2026-03-24T09:00:00.000Z'),
        acknowledged_at: new Date('2026-03-24T10:00:00.000Z'),
        completed_at: null,
        failed_at: null,
        verified_at: null,
        metadata: {},
        created_at: new Date('2026-03-24T09:00:00.000Z'),
        updated_at: new Date('2026-03-24T10:00:00.000Z'),
      },
      entries: [
        makeEntry({
          ledger_entry_id: 2,
          trade_id: 'trade-swept',
          amount_raw: '100',
          allocated_amount_raw: '90',
          matched_sweep_tx_hash: '0xclaim',
          matched_swept_at: new Date('2026-03-22T10:00:00.000Z'),
          partner_reference: 'handoff-33',
          partner_handoff_status: 'ACKNOWLEDGED',
          latest_bank_reference: 'bank-2',
          latest_bank_payout_state: 'PENDING',
          accounting_state: 'HANDED_OFF',
          accounting_state_reason: 'External handoff acknowledged by execution counterparty',
        }),
      ],
    });

    expect(report.claim_event?.tx_hash).toBe('0xclaim');
    expect(report.partner_handoff?.partner_reference).toBe('handoff-33');
    expect(report.entries[0]).toEqual(
      expect.objectContaining({
        trade_id: 'trade-swept',
        matched_sweep_tx_hash: '0xclaim',
        partner_reference: 'handoff-33',
        latest_bank_reference: 'bank-2',
      }),
    );
    expect(report.warning_issues.map((issue) => issue.code)).toContain(
      'ALLOCATED_AMOUNT_DIFFERS_FROM_SOURCE',
    );
  });

  test('close packet flags unresolved blocking issues and refuses close readiness', async () => {
    jest.mocked(queries.getAccountingPeriodById).mockResolvedValue(makePeriod());
    jest.mocked(queries.listLedgerEntryAccountingProjections).mockResolvedValue([
      makeEntry({
        ledger_entry_id: 2,
        trade_id: 'trade-501',
        amount_raw: '100',
        allocated_amount_raw: '100',
        allocated_at: new Date('2026-03-20T10:00:00.000Z'),
        sweep_batch_id: 11,
        sweep_batch_status: 'EXECUTED',
        allocation_status: 'ALLOCATED',
        matched_sweep_tx_hash: null,
        matched_swept_at: null,
        accounting_state: 'ALLOCATED_TO_SWEEP',
        accounting_state_reason: 'Ledger entry is allocated to a sweep batch',
      }),
    ]);
    jest.mocked(queries.listSweepBatches).mockResolvedValue([makeBatch({ status: 'EXECUTED' })]);
    jest.mocked(queries.getSweepBatchDetail).mockResolvedValue({
      batch: makeBatch({ status: 'EXECUTED' }),
      entries: [
        makeEntry({
          ledger_entry_id: 2,
          trade_id: 'trade-501',
          amount_raw: '100',
          allocated_amount_raw: '100',
          allocated_at: new Date('2026-03-20T10:00:00.000Z'),
          sweep_batch_id: 11,
          sweep_batch_status: 'EXECUTED',
          allocation_status: 'ALLOCATED',
          accounting_state: 'ALLOCATED_TO_SWEEP',
          accounting_state_reason: 'Ledger entry is allocated to a sweep batch',
        }),
      ],
      partnerHandoff: null,
      totals: {
        allocatedAmountRaw: '100',
        entryCount: 1,
      },
    });
    jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(null);

    const reconciliationGate = {
      assessTrades: jest.fn().mockResolvedValue(
        new Map([
          [
            'trade-501',
            {
              tradeId: 'trade-501',
              status: 'CLEAR',
              freshness: 'FRESH',
              runKey: 'run-1',
              completedAt: new Date('2026-03-31T22:00:00.000Z'),
              staleRunningRunCount: 0,
              blockedReasons: [],
              driftCount: 0,
            },
          ],
        ]),
      ),
      summarizeTrades: jest.fn().mockResolvedValue({
        status: 'CLEAR',
        freshness: 'FRESH',
        latestCompletedRunKey: 'run-1',
        latestCompletedRunAt: new Date('2026-03-31T22:00:00.000Z'),
        latestCompletedRunAgeSeconds: 60,
        staleRunningRunCount: 0,
        trackedTradeCount: 1,
        clearTradeCount: 1,
        blockedTradeCount: 0,
        unknownTradeCount: 0,
        driftBlockedTradeCount: 0,
        blockedReasons: [],
      }),
    };

    const packet = await loadTreasuryAccountingPeriodClosePacket(7, reconciliationGate as never);

    expect(packet.ready_for_close).toBe(false);
    expect(packet.blocking_issues.map((issue) => issue.code)).toContain('SWEEP_TX_UNMATCHED');
  });

  test('close packet paginates all sweep batches for the period before deciding close readiness', async () => {
    jest.mocked(queries.getAccountingPeriodById).mockResolvedValue(makePeriod());
    jest.mocked(queries.listLedgerEntryAccountingProjections).mockResolvedValue([]);

    const firstPage = Array.from({ length: 500 }, (_, index) =>
      makeBatch({
        id: index + 1,
        batch_key: `batch-${index + 1}`,
        status: 'CLOSED',
      }),
    );
    const blockingBatch = makeBatch({
      id: 501,
      batch_key: 'batch-501',
      status: 'EXECUTED',
    });

    jest
      .mocked(queries.listSweepBatches)
      .mockImplementation(async ({ offset = 0 }) =>
        offset === 0 ? firstPage : offset === 500 ? [blockingBatch] : [],
      );
    jest.mocked(queries.getSweepBatchDetail).mockImplementation(async (batchId: number) => ({
      batch: batchId === 501 ? blockingBatch : firstPage[batchId - 1],
      entries: [],
      partnerHandoff: null,
      totals: {
        allocatedAmountRaw: '0',
        entryCount: 0,
      },
    }));
    jest.mocked(queries.getTreasuryClaimEventByBatchId).mockResolvedValue(null);

    const reconciliationGate = {
      assessTrades: jest.fn().mockResolvedValue(new Map()),
      summarizeTrades: jest.fn().mockResolvedValue({
        status: 'CLEAR',
        freshness: 'FRESH',
        latestCompletedRunKey: 'run-1',
        latestCompletedRunAt: new Date('2026-03-31T22:00:00.000Z'),
        latestCompletedRunAgeSeconds: 60,
        staleRunningRunCount: 0,
        trackedTradeCount: 0,
        clearTradeCount: 0,
        blockedTradeCount: 0,
        unknownTradeCount: 0,
        driftBlockedTradeCount: 0,
        blockedReasons: [],
      }),
    };

    const packet = await loadTreasuryAccountingPeriodClosePacket(7, reconciliationGate as never);

    expect(queries.listSweepBatches).toHaveBeenCalledTimes(2);
    expect(packet.ready_for_close).toBe(false);
    expect(packet.blocking_issues.map((issue) => issue.code)).toContain('SWEEP_TX_UNMATCHED');
    expect(packet.batches).toHaveLength(501);
  });

  test('warning-only close issues surface without blocking close readiness', async () => {
    jest.mocked(queries.getAccountingPeriodById).mockResolvedValue(makePeriod());
    jest.mocked(queries.listLedgerEntryAccountingProjections).mockResolvedValue([
      makeEntry({
        ledger_entry_id: 9,
        trade_id: 'trade-warning',
        amount_raw: '100',
        allocated_amount_raw: '90',
        allocated_at: new Date('2026-03-20T10:00:00.000Z'),
        accounting_state: 'ALLOCATED_TO_SWEEP',
        accounting_state_reason: 'Ledger entry is allocated to a sweep batch',
      }),
    ]);
    jest.mocked(queries.listSweepBatches).mockResolvedValue([]);

    const reconciliationGate = {
      assessTrades: jest.fn().mockResolvedValue(new Map()),
      summarizeTrades: jest.fn().mockResolvedValue({
        status: 'CLEAR',
        freshness: 'FRESH',
        latestCompletedRunKey: 'run-1',
        latestCompletedRunAt: new Date('2026-03-31T22:00:00.000Z'),
        latestCompletedRunAgeSeconds: 60,
        staleRunningRunCount: 0,
        trackedTradeCount: 0,
        clearTradeCount: 0,
        blockedTradeCount: 0,
        unknownTradeCount: 0,
        driftBlockedTradeCount: 0,
        blockedReasons: [],
      }),
    };

    const packet = await loadTreasuryAccountingPeriodClosePacket(7, reconciliationGate as never);

    expect(packet.ready_for_close).toBe(true);
    expect(packet.blocking_issues).toHaveLength(0);
    expect(packet.warning_issues.map((issue) => issue.code)).toContain(
      'ALLOCATED_AMOUNT_DIFFERS_FROM_SOURCE',
    );
  });
});
