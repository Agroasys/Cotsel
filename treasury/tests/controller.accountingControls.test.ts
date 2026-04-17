import type { Request, Response } from 'express';

process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  listLedgerEntryAccountingProjections: jest.fn(),
  updateAccountingPeriodStatus: jest.fn(),
}));

jest.mock('../src/core/closeReporting', () => ({
  loadTreasuryAccountingPeriodClosePacket: jest.fn(),
  loadTreasuryBatchTraceReport: jest.fn(),
  renderTreasuryAccountingPeriodClosePacketMarkdown: jest.fn().mockReturnValue('# close packet'),
}));

type TreasuryControllerType = typeof import('../src/api/controller').TreasuryController;
type QueriesModule = typeof import('../src/database/queries');
type CloseReportingModule = typeof import('../src/core/closeReporting');

type MockResponse = Response & {
  status: jest.MockedFunction<(code: number) => MockResponse>;
  json: jest.MockedFunction<(body: unknown) => MockResponse>;
};

type ListEntryAccountingRequest = Request<
  Record<string, never>,
  unknown,
  unknown,
  {
    accountingState?: string;
    accountingPeriodId?: string;
    sweepBatchId?: string;
    tradeId?: string;
    limit?: string;
    offset?: string;
  }
>;

type CloseAccountingPeriodRequest = Request<
  { periodId: string },
  unknown,
  { actor: string; closeReason?: string }
>;

let LoadedTreasuryController: TreasuryControllerType;
let queriesModule: QueriesModule;
let closeReportingModule: CloseReportingModule;

function mockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

describe('TreasuryController accounting controls', () => {
  beforeEach(async () => {
    jest.resetModules();
    ({ TreasuryController: LoadedTreasuryController } = await import('../src/api/controller'));
    queriesModule = await import('../src/database/queries');
    closeReportingModule = await import('../src/core/closeReporting');
    jest.clearAllMocks();
  });

  test('listEntryAccounting returns projected accounting state rows', async () => {
    jest.mocked(queriesModule.listLedgerEntryAccountingProjections).mockResolvedValue([
      {
        ledger_entry_id: 501,
        trade_id: 'trade-501',
        component_type: 'PLATFORM_FEE',
        amount_raw: '125000000',
        allocated_amount_raw: '125000000',
        earned_at: new Date('2026-03-31T10:00:00.000Z'),
        payout_state: 'EXTERNAL_EXECUTION_CONFIRMED',
        accounting_period_id: 7,
        accounting_period_key: '2026-Q1',
        accounting_period_status: 'OPEN',
        sweep_batch_id: 11,
        sweep_batch_status: 'EXECUTED',
        allocation_status: 'ALLOCATED',
        matched_sweep_tx_hash: '0xsweep-1',
        matched_sweep_block_number: 101,
        matched_swept_at: new Date('2026-03-31T12:00:00.000Z'),
        matched_treasury_identity: '0xtreasury',
        matched_payout_receiver: '0xpayout',
        matched_claim_amount_raw: '125000000',
        partner_handoff_id: null,
        partner_name: null,
        partner_reference: null,
        partner_handoff_status: null,
        partner_completed_at: null,
        latest_fiat_deposit_state: 'FUNDED',
        latest_bank_payout_state: 'CONFIRMED',
        revenue_realization_status: null,
        realized_at: null,
        accounting_state: 'SWEPT',
        accounting_state_reason: 'Matched on-chain treasury claim recorded',
      },
    ]);

    const controller = new LoadedTreasuryController();
    const req = {
      query: {
        accountingState: 'SWEPT',
        limit: '25',
        offset: '0',
      },
    } as unknown as ListEntryAccountingRequest;
    const res = mockResponse();

    await controller.listEntryAccounting(req, res);

    expect(queriesModule.listLedgerEntryAccountingProjections).toHaveBeenCalledWith({
      accountingState: 'SWEPT',
      accountingPeriodId: undefined,
      sweepBatchId: undefined,
      tradeId: undefined,
      limit: 25,
      offset: 0,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('closeAccountingPeriod fails closed when reconciliation is not clear for batch trades', async () => {
    jest.mocked(closeReportingModule.loadTreasuryAccountingPeriodClosePacket).mockResolvedValue({
      period: {
        id: 7,
        period_key: '2026-Q1',
        starts_at: new Date('2026-01-01T00:00:00.000Z'),
        ends_at: new Date('2026-03-31T23:59:59.000Z'),
        status: 'PENDING_CLOSE',
        created_by: 'user:uid-admin',
        close_reason: null,
        pending_close_at: null,
        closed_at: null,
        closed_by: null,
        metadata: {},
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-03-31T23:00:00.000Z'),
      },
      generated_at: '2026-03-31T23:30:00.000Z',
      ready_for_close: false,
      rollforward: {
        period: {
          id: 7,
          period_key: '2026-Q1',
          starts_at: new Date('2026-01-01T00:00:00.000Z'),
          ends_at: new Date('2026-03-31T23:59:59.000Z'),
          status: 'PENDING_CLOSE',
          created_by: 'user:uid-admin',
          close_reason: null,
          pending_close_at: null,
          closed_at: null,
          closed_by: null,
          metadata: {},
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-03-31T23:00:00.000Z'),
        },
        generated_at: '2026-03-31T23:30:00.000Z',
        opening_held_raw: '0',
        new_accruals_raw: '0',
        allocated_to_batches_raw: '0',
        swept_onchain_raw: '0',
        handed_off_raw: '0',
        realized_raw: '0',
        ending_held_raw: '0',
        unresolved_exception_raw: '0',
        blocking_issue_count: 1,
        warning_issue_count: 0,
        blocking_issues: [],
        warning_issues: [],
      },
      reconciliation: {
        status: 'BLOCKED',
        freshness: 'FRESH',
        latest_completed_run_key: 'run-1',
        latest_completed_run_at: '2026-03-31T14:00:00.000Z',
        stale_running_run_count: 0,
        blocked_reasons: ['Latest reconciliation run reported 1 drift finding(s)'],
      },
      batches: [],
      blocking_issues: [
        {
          code: 'PERIOD_RECONCILIATION_BLOCKED',
          severity: 'BLOCKING',
          owner: 'RECONCILIATION',
          message: 'Accounting period reconciliation is not clear',
          trade_id: null,
          sweep_batch_id: null,
          ledger_entry_id: null,
          details: {},
        },
      ],
      warning_issues: [],
    });

    const controller = new LoadedTreasuryController();
    const req = {
      params: { periodId: '7' },
      body: { actor: 'user:uid-admin', closeReason: 'Quarter close review' },
    } as unknown as CloseAccountingPeriodRequest;
    const res = mockResponse();

    await controller.closeAccountingPeriod(req, res);

    expect(queriesModule.updateAccountingPeriodStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'CloseBlocked',
        message: expect.stringContaining('blocking treasury close issues remain'),
      }),
    );
  });

  test('closeAccountingPeriod delegates blocking close truth to the close packet loader', async () => {
    jest.mocked(closeReportingModule.loadTreasuryAccountingPeriodClosePacket).mockResolvedValue({
      period: {
        id: 7,
        period_key: '2026-Q1',
        starts_at: new Date('2026-01-01T00:00:00.000Z'),
        ends_at: new Date('2026-03-31T23:59:59.000Z'),
        status: 'PENDING_CLOSE',
        created_by: 'user:uid-admin',
        close_reason: null,
        pending_close_at: null,
        closed_at: null,
        closed_by: null,
        metadata: {},
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-03-31T23:00:00.000Z'),
      },
      generated_at: '2026-03-31T23:30:00.000Z',
      ready_for_close: false,
      rollforward: {
        period: {
          id: 7,
          period_key: '2026-Q1',
          starts_at: new Date('2026-01-01T00:00:00.000Z'),
          ends_at: new Date('2026-03-31T23:59:59.000Z'),
          status: 'PENDING_CLOSE',
          created_by: 'user:uid-admin',
          close_reason: null,
          pending_close_at: null,
          closed_at: null,
          closed_by: null,
          metadata: {},
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-03-31T23:00:00.000Z'),
        },
        generated_at: '2026-03-31T23:30:00.000Z',
        opening_held_raw: '0',
        new_accruals_raw: '0',
        allocated_to_batches_raw: '0',
        swept_onchain_raw: '0',
        handed_off_raw: '0',
        realized_raw: '0',
        ending_held_raw: '0',
        unresolved_exception_raw: '0',
        blocking_issue_count: 1,
        warning_issue_count: 0,
        blocking_issues: [
          {
            code: 'SWEEP_TX_UNMATCHED',
            severity: 'BLOCKING',
            owner: 'TREASURY',
            message: 'Sweep batch is marked executed without matched treasury claim evidence',
            trade_id: null,
            sweep_batch_id: 999,
            ledger_entry_id: null,
            details: {
              batchStatus: 'EXECUTED',
            },
          },
        ],
        warning_issues: [],
      },
      reconciliation: {
        status: 'CLEAR',
        freshness: 'FRESH',
        latest_completed_run_key: 'run-1',
        latest_completed_run_at: '2026-03-31T23:00:00.000Z',
        stale_running_run_count: 0,
        blocked_reasons: [],
      },
      batches: [],
      blocking_issues: [
        {
          code: 'SWEEP_TX_UNMATCHED',
          severity: 'BLOCKING',
          owner: 'TREASURY',
          message: 'Sweep batch is marked executed without matched treasury claim evidence',
          trade_id: null,
          sweep_batch_id: 999,
          ledger_entry_id: null,
          details: {
            batchStatus: 'EXECUTED',
          },
        },
      ],
      warning_issues: [],
    });

    const controller = new LoadedTreasuryController();
    const req = {
      params: { periodId: '7' },
      body: { actor: 'user:uid-admin', closeReason: 'Quarter close review' },
    } as unknown as CloseAccountingPeriodRequest;
    const res = mockResponse();

    await controller.closeAccountingPeriod(req, res);

    expect(closeReportingModule.loadTreasuryAccountingPeriodClosePacket).toHaveBeenCalledWith(
      7,
      expect.anything(),
    );
    expect(queriesModule.updateAccountingPeriodStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'CloseBlocked',
        message: expect.stringContaining('blocking treasury close issues remain'),
      }),
    );
  });
});
