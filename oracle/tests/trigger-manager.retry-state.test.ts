import { TriggerManager } from '../src/core/trigger-manager';
import { ErrorType, Trigger, TriggerStatus, TriggerType } from '../src/types/trigger';
import {
  createTrigger,
  getLatestTriggerByActionKey,
  getTriggerByIdempotencyKey,
  updateTrigger,
} from '../src/database/queries';
import { incrementOracleExhaustedRetries } from '../src/metrics/counters';

jest.mock('@agroasys/sdk', () => ({
  TradeStatus: {
    LOCKED: 0,
    IN_TRANSIT: 1,
    ARRIVAL_CONFIRMED: 2,
    FROZEN: 3,
    CLOSED: 4,
  },
}));

jest.mock('../src/database/queries', () => ({
  createTrigger: jest.fn(),
  getTriggerByIdempotencyKey: jest.fn(),
  getLatestTriggerByActionKey: jest.fn(),
  updateTrigger: jest.fn(),
}));

jest.mock('../src/metrics/counters', () => ({
  incrementOracleExhaustedRetries: jest.fn(),
  incrementOracleRedriveAttempts: jest.fn(),
}));

jest.mock('../src/utils/crypto', () => {
  const actual = jest.requireActual('../src/utils/crypto');
  return {
    ...actual,
    calculateBackoff: jest.fn(() => 0),
  };
});

const mockedCreateTrigger = createTrigger as jest.MockedFunction<typeof createTrigger>;
const mockedGetLatestTriggerByActionKey = getLatestTriggerByActionKey as jest.MockedFunction<
  typeof getLatestTriggerByActionKey
>;
const mockedGetTriggerByIdempotencyKey = getTriggerByIdempotencyKey as jest.MockedFunction<
  typeof getTriggerByIdempotencyKey
>;
const mockedUpdateTrigger = updateTrigger as jest.MockedFunction<typeof updateTrigger>;
const mockedIncrementOracleExhaustedRetries =
  incrementOracleExhaustedRetries as jest.MockedFunction<typeof incrementOracleExhaustedRetries>;

const TRADE_STATUS_LOCKED = 0;
type TriggerManagerSdkClient = ConstructorParameters<typeof TriggerManager>[0];
type TradeRecord = Awaited<ReturnType<TriggerManagerSdkClient['getTrade']>>;

function buildTrade(status: number = TRADE_STATUS_LOCKED): TradeRecord {
  return {
    tradeId: '1',
    buyer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    supplier: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    status,
    totalAmountLocked: 1000n,
    logisticsAmount: 100n,
    platformFeesAmount: 50n,
    supplierFirstTranche: 350n,
    supplierSecondTranche: 500n,
    ricardianHash: '0x' + '11'.repeat(32),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function buildTrigger(status: TriggerStatus = TriggerStatus.PENDING): Trigger {
  return {
    id: 1,
    action_key: 'RELEASE_STAGE_1:1',
    request_id: 'req-1',
    idempotency_key: 'RELEASE_STAGE_1:1:req-1',
    trade_id: '1',
    trigger_type: TriggerType.RELEASE_STAGE_1,
    request_hash: null,
    attempt_count: 0,
    status,
    tx_hash: null,
    block_number: null,
    confirmation_stage: null,
    confirmation_stage_at: null,
    indexer_confirmed: false,
    indexer_confirmed_at: null,
    indexer_event_id: null,
    last_error: null,
    error_type: null as ErrorType | null,
    on_chain_verified: false,
    on_chain_verified_at: null,
    approved_by: null,
    approved_at: null,
    rejected_by: null,
    rejected_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    submitted_at: null,
    confirmed_at: null,
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('TriggerManager retry and idempotency states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns idempotent response when latest action is already submitted', async () => {
    const latest = buildTrigger(TriggerStatus.SUBMITTED);
    latest.tx_hash = '0x' + 'aa'.repeat(32);
    latest.block_number = 123n;

    mockedGetLatestTriggerByActionKey.mockResolvedValue(latest);

    const sdkClient: TriggerManagerSdkClient = {
      getTrade: jest.fn(),
      releaseFundsStage1: jest.fn(),
      confirmArrival: jest.fn(),
      finalizeTrade: jest.fn(),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 3, 1);
    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    expect(response.status).toBe(TriggerStatus.SUBMITTED);
    expect(response.message).toContain('already completed');
    expect(mockedCreateTrigger).not.toHaveBeenCalled();
    expect(mockedUpdateTrigger).not.toHaveBeenCalled();
  });

  it('transitions to exhausted when retry ceiling is reached', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue(buildTrigger(TriggerStatus.PENDING));

    const sdkClient: TriggerManagerSdkClient = {
      getTrade: jest.fn().mockResolvedValue(buildTrade(TRADE_STATUS_LOCKED)),
      releaseFundsStage1: jest
        .fn()
        .mockRejectedValue(new Error('timeout while sending transaction')),
      confirmArrival: jest.fn(),
      finalizeTrade: jest.fn(),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 2, 1);
    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-retry',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    expect(sdkClient.releaseFundsStage1).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE);
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: TriggerStatus.FAILED, attempt_count: 1 }),
    );
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: TriggerStatus.EXHAUSTED_NEEDS_REDRIVE, attempt_count: 2 }),
    );
    expect(mockedIncrementOracleExhaustedRetries).toHaveBeenCalledWith('RELEASE_STAGE_1:1');
  });

  it('transitions immediately to terminal failure for terminal errors without retrying', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue(buildTrigger(TriggerStatus.PENDING));

    const sdkClient: TriggerManagerSdkClient = {
      getTrade: jest.fn().mockResolvedValue(buildTrade(TRADE_STATUS_LOCKED)),
      releaseFundsStage1: jest
        .fn()
        .mockRejectedValue(new Error('execution reverted: oracle disabled')),
      confirmArrival: jest.fn(),
      finalizeTrade: jest.fn(),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 3, 1);
    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-terminal',
      triggerType: TriggerType.RELEASE_STAGE_1,
    });

    expect(sdkClient.releaseFundsStage1).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(TriggerStatus.TERMINAL_FAILURE);
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: TriggerStatus.TERMINAL_FAILURE, attempt_count: 1 }),
    );
    expect(mockedIncrementOracleExhaustedRetries).not.toHaveBeenCalled();
  });
});
