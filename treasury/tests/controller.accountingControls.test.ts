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
  getSweepBatchDetail: jest.fn(),
  listLedgerEntryAccountingProjections: jest.fn(),
  listSweepBatches: jest.fn(),
  updateAccountingPeriodStatus: jest.fn(),
}));

type TreasuryControllerType = typeof import('../src/api/controller').TreasuryController;
type ReconciliationGateServiceType =
  typeof import('../src/core/reconciliationGate').ReconciliationGateService;
type QueriesModule = typeof import('../src/database/queries');

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
let LoadedReconciliationGateService: ReconciliationGateServiceType;
let queriesModule: QueriesModule;

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
    ({ ReconciliationGateService: LoadedReconciliationGateService } =
      await import('../src/core/reconciliationGate'));
    queriesModule = await import('../src/database/queries');
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
    jest.mocked(queriesModule.listSweepBatches).mockResolvedValue([
      {
        id: 11,
        batch_key: 'batch-q1-001',
        accounting_period_id: 7,
        accounting_period_key: '2026-Q1',
        accounting_period_status: 'OPEN',
        asset_symbol: 'USDC',
        status: 'CLOSED',
        expected_total_raw: '125000000',
        payout_receiver_address: null,
        approval_requested_at: null,
        approval_requested_by: null,
        approved_at: null,
        approved_by: null,
        matched_sweep_tx_hash: '0xsweep-1',
        matched_sweep_block_number: '101',
        matched_swept_at: new Date('2026-03-31T12:00:00.000Z'),
        executed_by: 'user:uid-admin',
        closed_at: new Date('2026-03-31T13:00:00.000Z'),
        closed_by: 'user:uid-close',
        created_by: 'user:uid-admin',
        metadata: {},
        created_at: new Date('2026-03-31T11:00:00.000Z'),
        updated_at: new Date('2026-03-31T12:00:00.000Z'),
      },
    ]);
    jest.mocked(queriesModule.getSweepBatchDetail).mockResolvedValue({
      batch: {
        id: 11,
        batch_key: 'batch-q1-001',
        accounting_period_id: 7,
        accounting_period_key: '2026-Q1',
        accounting_period_status: 'OPEN',
        asset_symbol: 'USDC',
        status: 'CLOSED',
        expected_total_raw: '125000000',
        payout_receiver_address: null,
        approval_requested_at: null,
        approval_requested_by: null,
        approved_at: null,
        approved_by: null,
        matched_sweep_tx_hash: '0xsweep-1',
        matched_sweep_block_number: '101',
        matched_swept_at: new Date('2026-03-31T12:00:00.000Z'),
        executed_by: 'user:uid-admin',
        closed_at: new Date('2026-03-31T13:00:00.000Z'),
        closed_by: 'user:uid-close',
        created_by: 'user:uid-admin',
        metadata: {},
        created_at: new Date('2026-03-31T11:00:00.000Z'),
        updated_at: new Date('2026-03-31T12:00:00.000Z'),
      },
      entries: [
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
          sweep_batch_status: 'CLOSED',
          allocation_status: 'ALLOCATED',
          matched_sweep_tx_hash: '0xsweep-1',
          matched_sweep_block_number: 101,
          matched_swept_at: new Date('2026-03-31T12:00:00.000Z'),
          matched_treasury_identity: '0xtreasury',
          matched_payout_receiver: '0xpayout',
          matched_claim_amount_raw: '125000000',
          partner_handoff_id: 33,
          partner_name: 'licensed-partner',
          partner_reference: 'partner-ref-1',
          partner_handoff_status: 'COMPLETED',
          partner_completed_at: new Date('2026-03-31T13:00:00.000Z'),
          latest_fiat_deposit_state: 'FUNDED',
          latest_bank_payout_state: 'CONFIRMED',
          revenue_realization_status: 'REALIZED',
          realized_at: new Date('2026-03-31T13:30:00.000Z'),
          accounting_state: 'REALIZED',
          accounting_state_reason: 'Controlled revenue realization recorded',
        },
      ],
      partnerHandoff: {
        id: 33,
        sweep_batch_id: 11,
        partner_name: 'licensed-partner',
        partner_reference: 'partner-ref-1',
        handoff_status: 'COMPLETED',
        latest_payload_hash: 'hash',
        evidence_reference: 'evidence://partner-ref-1',
        submitted_at: new Date('2026-03-31T12:05:00.000Z'),
        acknowledged_at: new Date('2026-03-31T12:10:00.000Z'),
        completed_at: new Date('2026-03-31T13:00:00.000Z'),
        failed_at: null,
        verified_at: new Date('2026-03-31T13:05:00.000Z'),
        metadata: {},
        created_at: new Date('2026-03-31T12:05:00.000Z'),
        updated_at: new Date('2026-03-31T13:05:00.000Z'),
      },
      totals: {
        allocatedAmountRaw: '125000000',
        entryCount: 1,
      },
    });
    jest.spyOn(LoadedReconciliationGateService.prototype, 'summarizeTrades').mockResolvedValue({
      status: 'BLOCKED',
      freshness: 'FRESH',
      latestCompletedRunKey: 'run-1',
      latestCompletedRunAt: new Date('2026-03-31T14:00:00.000Z'),
      latestCompletedRunAgeSeconds: 90,
      staleRunningRunCount: 0,
      trackedTradeCount: 1,
      clearTradeCount: 0,
      blockedTradeCount: 1,
      unknownTradeCount: 0,
      driftBlockedTradeCount: 1,
      blockedReasons: ['Latest reconciliation run reported 1 drift finding(s)'],
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
        message: expect.stringContaining('reconciliation is not clear'),
      }),
    );
  });

  test('closeAccountingPeriod scans every sweep-batch page before allowing period close', async () => {
    jest
      .mocked(queriesModule.listSweepBatches)
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          id: index + 1,
          batch_key: `batch-q1-${index + 1}`,
          accounting_period_id: 7,
          accounting_period_key: '2026-Q1',
          accounting_period_status: 'OPEN',
          asset_symbol: 'USDC',
          status: 'CLOSED',
          expected_total_raw: '125000000',
          payout_receiver_address: null,
          approval_requested_at: null,
          approval_requested_by: null,
          approved_at: null,
          approved_by: null,
          matched_sweep_tx_hash: '0xsweep-1',
          matched_sweep_block_number: '101',
          matched_swept_at: new Date('2026-03-31T12:00:00.000Z'),
          executed_by: 'user:uid-admin',
          closed_at: new Date('2026-03-31T13:00:00.000Z'),
          closed_by: 'user:uid-close',
          created_by: 'user:uid-admin',
          metadata: {},
          created_at: new Date('2026-03-31T11:00:00.000Z'),
          updated_at: new Date('2026-03-31T12:00:00.000Z'),
        })),
      )
      .mockResolvedValueOnce([
        {
          id: 999,
          batch_key: 'batch-q1-999',
          accounting_period_id: 7,
          accounting_period_key: '2026-Q1',
          accounting_period_status: 'OPEN',
          asset_symbol: 'USDC',
          status: 'APPROVED',
          expected_total_raw: '125000000',
          payout_receiver_address: null,
          approval_requested_at: null,
          approval_requested_by: null,
          approved_at: null,
          approved_by: null,
          matched_sweep_tx_hash: '0xsweep-999',
          matched_sweep_block_number: '101',
          matched_swept_at: new Date('2026-03-31T12:00:00.000Z'),
          executed_by: 'user:uid-admin',
          closed_at: null,
          closed_by: null,
          created_by: 'user:uid-admin',
          metadata: {},
          created_at: new Date('2026-03-31T11:00:00.000Z'),
          updated_at: new Date('2026-03-31T12:00:00.000Z'),
        },
      ]);

    const controller = new LoadedTreasuryController();
    const req = {
      params: { periodId: '7' },
      body: { actor: 'user:uid-admin', closeReason: 'Quarter close review' },
    } as unknown as CloseAccountingPeriodRequest;
    const res = mockResponse();

    await controller.closeAccountingPeriod(req, res);

    expect(queriesModule.listSweepBatches).toHaveBeenNthCalledWith(1, {
      accountingPeriodId: 7,
      limit: 500,
      offset: 0,
    });
    expect(queriesModule.listSweepBatches).toHaveBeenNthCalledWith(2, {
      accountingPeriodId: 7,
      limit: 500,
      offset: 500,
    });
    expect(queriesModule.updateAccountingPeriodStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'CloseBlocked',
        message: expect.stringContaining('sweep batches remain open'),
      }),
    );
  });
});
