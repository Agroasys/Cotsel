import type { Request, Response } from 'express';
import type {
  LedgerEntry,
  LedgerEntryWithState,
  PayoutLifecycleEvent,
  PayoutState,
} from '../src/types';

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
  getLedgerEntries: jest.fn(),
  getLedgerEntryById: jest.fn(),
  getLatestPayoutState: jest.fn(),
  appendPayoutState: jest.fn(),
}));

type TreasuryControllerType = typeof import('../src/api/controller').TreasuryController;
type TreasuryEligibilityServiceType =
  typeof import('../src/core/exportEligibility').TreasuryEligibilityService;
type QueriesModule = typeof import('../src/database/queries');

type MockResponse = Response & {
  status: jest.MockedFunction<(code: number) => MockResponse>;
  json: jest.MockedFunction<(body: unknown) => MockResponse>;
  send: jest.MockedFunction<(body?: unknown) => MockResponse>;
  setHeader: jest.Mock;
};

type AppendStateRequest = Request<{ entryId: string }, unknown, { state: string }>;
type ExportEntriesRequest = Request<Record<string, never>, unknown, unknown, { format: string }>;

let LoadedTreasuryController: TreasuryControllerType;
let LoadedTreasuryEligibilityService: TreasuryEligibilityServiceType;
let queriesModule: QueriesModule;

function mockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  response.send = jest.fn().mockReturnValue(response);
  response.setHeader = jest.fn();
  return response;
}

function makeEntry(id: number): LedgerEntryWithState {
  return {
    id,
    entry_key: `entry-${id}`,
    trade_id: `trade-${id}`,
    tx_hash: `0xtx-${id}`,
    block_number: 100,
    event_name: 'PlatformFeesPaidStage1',
    component_type: 'PLATFORM_FEE',
    amount_raw: '42',
    source_timestamp: new Date('2026-03-31T00:00:00.000Z'),
    metadata: {},
    created_at: new Date('2026-03-31T00:00:00.000Z'),
    latest_state: 'READY_FOR_PARTNER_SUBMISSION' satisfies PayoutState,
    latest_state_at: new Date('2026-03-31T00:00:00.000Z'),
  };
}

function makeLedgerEntry(id: number, tradeId: string): LedgerEntry {
  return {
    id,
    entry_key: `entry-${id}`,
    trade_id: tradeId,
    tx_hash: `0xtx-${id}`,
    block_number: 100,
    event_name: 'PlatformFeesPaidStage1',
    component_type: 'PLATFORM_FEE',
    amount_raw: '42',
    source_timestamp: new Date('2026-03-31T00:00:00.000Z'),
    metadata: {},
    created_at: new Date('2026-03-31T00:00:00.000Z'),
  };
}

function makePayoutEvent(state: PayoutState): PayoutLifecycleEvent {
  return {
    id: 1,
    ledger_entry_id: 11,
    state,
    note: null,
    actor: null,
    created_at: new Date('2026-03-31T00:00:00.000Z'),
  };
}

describe('TreasuryController eligibility gates', () => {
  beforeEach(async () => {
    jest.resetModules();
    ({ TreasuryController: LoadedTreasuryController } = await import('../src/api/controller'));
    ({ TreasuryEligibilityService: LoadedTreasuryEligibilityService } =
      await import('../src/core/exportEligibility'));
    queriesModule = await import('../src/database/queries');

    jest.clearAllMocks();
  });

  test('appendState blocks READY_FOR_PARTNER_SUBMISSION when eligibility is not clear', async () => {
    jest.spyOn(LoadedTreasuryEligibilityService.prototype, 'assessEntries').mockResolvedValue(
      new Map([
        [
          11,
          {
            entryId: 11,
            tradeId: 'trade-1',
            payoutState: 'PENDING_REVIEW',
            confirmationStage: 'SAFE',
            latestBlockNumber: 120,
            safeBlockNumber: 115,
            finalizedBlockNumber: 100,
            reconciliationStatus: 'BLOCKED',
            reconciliationRunKey: 'run-1',
            eligibleForPayout: false,
            eligibleForExport: false,
            blockedReasons: ['Entry has not reached Base finalized stage (current stage: SAFE)'],
          },
        ],
      ]),
    );

    jest.mocked(queriesModule.getLedgerEntryById).mockResolvedValue(makeLedgerEntry(11, 'trade-1'));
    jest.mocked(queriesModule.getLedgerEntries).mockResolvedValue([makeEntry(11)]);
    jest
      .mocked(queriesModule.getLatestPayoutState)
      .mockResolvedValue(makePayoutEvent('PENDING_REVIEW'));

    const controller = new LoadedTreasuryController();
    const res = mockResponse();
    const req = {
      params: { entryId: '11' },
      body: { state: 'READY_FOR_PARTNER_SUBMISSION' },
    } as unknown as AppendStateRequest;

    await controller.appendState(req, res);

    expect(queriesModule.appendPayoutState).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'EligibilityBlocked',
        message: expect.stringContaining('Ledger entry is not eligible for payout'),
      }),
    );
  });

  test('appendState blocks manual completion without confirmed payout evidence', async () => {
    jest.mocked(queriesModule.getLedgerEntryById).mockResolvedValue(makeLedgerEntry(11, 'trade-1'));
    jest
      .mocked(queriesModule.getLatestPayoutState)
      .mockResolvedValue(makePayoutEvent('AWAITING_PARTNER_UPDATE'));

    const controller = new LoadedTreasuryController();
    const res = mockResponse();
    const req = {
      params: { entryId: '11' },
      body: { state: 'PARTNER_REPORTED_COMPLETED' },
    } as unknown as AppendStateRequest;

    await controller.appendState(req, res);

    expect(queriesModule.appendPayoutState).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'EvidenceRequired',
      }),
    );
  });

  test('exportEntries returns only entries that passed confirmation and reconciliation gates', async () => {
    jest.spyOn(LoadedTreasuryEligibilityService.prototype, 'assessEntries').mockResolvedValue(
      new Map([
        [
          11,
          {
            entryId: 11,
            tradeId: 'trade-11',
            payoutState: 'READY_FOR_PARTNER_SUBMISSION',
            confirmationStage: 'FINALIZED',
            latestBlockNumber: 120,
            safeBlockNumber: 115,
            finalizedBlockNumber: 110,
            reconciliationStatus: 'CLEAR',
            reconciliationRunKey: 'run-1',
            eligibleForPayout: true,
            eligibleForExport: true,
            blockedReasons: [],
          },
        ],
        [
          12,
          {
            entryId: 12,
            tradeId: 'trade-12',
            payoutState: 'READY_FOR_PARTNER_SUBMISSION',
            confirmationStage: 'SAFE',
            latestBlockNumber: 120,
            safeBlockNumber: 115,
            finalizedBlockNumber: 110,
            reconciliationStatus: 'CLEAR',
            reconciliationRunKey: 'run-1',
            eligibleForPayout: false,
            eligibleForExport: false,
            blockedReasons: ['Entry has not reached Base finalized stage (current stage: SAFE)'],
          },
        ],
      ]),
    );

    jest.mocked(queriesModule.getLedgerEntries).mockResolvedValue([makeEntry(11), makeEntry(12)]);

    const controller = new LoadedTreasuryController();
    const res = mockResponse();
    const req = { query: { format: 'json' } } as unknown as ExportEntriesRequest;

    await controller.exportEntries(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [
          expect.objectContaining({
            id: 11,
            eligibleForExport: true,
          }),
        ],
      }),
    );
  });
});
