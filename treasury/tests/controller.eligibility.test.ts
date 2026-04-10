process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL = process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  getLedgerEntries: jest.fn(),
  getLedgerEntryById: jest.fn(),
  getLatestPayoutState: jest.fn(),
  appendPayoutState: jest.fn(),
}));

const { TreasuryController } = require('../src/api/controller') as typeof import('../src/api/controller');
const { TreasuryEligibilityService } = require('../src/core/exportEligibility') as typeof import('../src/core/exportEligibility');
const {
  getLedgerEntries,
  getLedgerEntryById,
  getLatestPayoutState,
  appendPayoutState,
} = require('../src/database/queries') as typeof import('../src/database/queries');

function mockResponse() {
  const response: any = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  response.send = jest.fn().mockReturnValue(response);
  response.setHeader = jest.fn();
  return response;
}

function makeEntry(id: number) {
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
    latest_state: 'READY_FOR_PAYOUT',
    latest_state_at: new Date('2026-03-31T00:00:00.000Z'),
  };
}

describe('TreasuryController eligibility gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('appendState blocks READY_FOR_PAYOUT when eligibility is not clear', async () => {
    jest.spyOn(TreasuryEligibilityService.prototype, 'assessEntries').mockResolvedValue(
      new Map([
        [11, {
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
        }],
      ]),
    );

    (getLedgerEntryById as jest.Mock).mockResolvedValue({ id: 11, trade_id: 'trade-1' });
    (getLedgerEntries as jest.Mock).mockResolvedValue([makeEntry(11)]);
    (getLatestPayoutState as jest.Mock).mockResolvedValue({ state: 'PENDING_REVIEW' });

    const controller = new TreasuryController();
    const res = mockResponse();

    await controller.appendState(
      {
        params: { entryId: '11' },
        body: { state: 'READY_FOR_PAYOUT' },
      } as any,
      res,
    );

    expect(appendPayoutState).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'EligibilityBlocked',
        message: expect.stringContaining('Ledger entry is not eligible for payout'),
      }),
    );
  });

  test('exportEntries returns only entries that passed confirmation and reconciliation gates', async () => {
    jest.spyOn(TreasuryEligibilityService.prototype, 'assessEntries').mockResolvedValue(
      new Map([
        [11, {
          entryId: 11,
          tradeId: 'trade-11',
          payoutState: 'READY_FOR_PAYOUT',
          confirmationStage: 'FINALIZED',
          latestBlockNumber: 120,
          safeBlockNumber: 115,
          finalizedBlockNumber: 110,
          reconciliationStatus: 'CLEAR',
          reconciliationRunKey: 'run-1',
          eligibleForPayout: true,
          eligibleForExport: true,
          blockedReasons: [],
        }],
        [12, {
          entryId: 12,
          tradeId: 'trade-12',
          payoutState: 'READY_FOR_PAYOUT',
          confirmationStage: 'SAFE',
          latestBlockNumber: 120,
          safeBlockNumber: 115,
          finalizedBlockNumber: 110,
          reconciliationStatus: 'CLEAR',
          reconciliationRunKey: 'run-1',
          eligibleForPayout: false,
          eligibleForExport: false,
          blockedReasons: ['Entry has not reached Base finalized stage (current stage: SAFE)'],
        }],
      ]),
    );

    (getLedgerEntries as jest.Mock).mockResolvedValue([makeEntry(11), makeEntry(12)]);

    const controller = new TreasuryController();
    const res = mockResponse();

    await controller.exportEntries(
      { query: { format: 'json' } } as any,
      res,
    );

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
