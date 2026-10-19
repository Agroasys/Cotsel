import { buildTrade, buildTrigger } from './helpers/triggerState';
import { fundedBindingFixture } from './helpers/fundedBinding';
import { TriggerManager } from '../src/core/trigger-manager';
import { TriggerStatus, TriggerType } from '../src/types/trigger';
import {
  createTrigger,
  getLatestTriggerByActionKey,
  getTriggerByIdempotencyKey,
  updateTrigger,
} from '../src/database/queries';
import { incrementOracleExhaustedRetries } from '../src/metrics/counters';

// These scenarios are about retry, idempotency and approval state, not about
// PRES-11 containment, so the gate is stubbed open. Its own behaviour — and the
// proof that a contained trade cannot progress — is in
// trigger-manager.containment.test.ts.
jest.mock('../src/core/containment-guard', () => ({
  createContainmentGuard: () => ({
    assertMayProgress: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('@agroasys/sdk', () => ({
  ...jest.requireActual('@agroasys/sdk'),
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
  claimTriggerDispatch: jest.fn().mockResolvedValue(true),
  getUnresolvedSignerDispatch: jest.fn().mockResolvedValue(null),
  resolveSignerDispatch: jest.fn().mockResolvedValue(undefined),
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
      getDispatchSignerScope: jest
        .fn()
        .mockResolvedValue('31337:0x3333333333333333333333333333333333333333'),
      verifyDispatchFinality: jest.fn(),
      assertFundedBinding: jest.fn().mockResolvedValue(undefined),
      getTrade: jest.fn(),
      releaseFundsStage1: jest.fn(),
      confirmInspectionAvailable: jest.fn(),
      finalizeTrade: jest.fn(),
      isTradePaused: jest.fn().mockResolvedValue(false),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 3, 1);
    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
      fundedBinding: fundedBindingFixture(TriggerType.RELEASE_STAGE_1),
    });

    expect(response.status).toBe(TriggerStatus.SUBMITTED);
    expect(response.message).toContain('already completed');
    expect(mockedCreateTrigger).not.toHaveBeenCalled();
    expect(mockedUpdateTrigger).not.toHaveBeenCalled();
  });

  it('serializes final release and rejects replacement of an accepted execution purpose', async () => {
    const latest = {
      ...buildTrigger(TriggerStatus.SUBMITTED),
      action_key: 'FINAL_RELEASE:1',
      trigger_type: TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE,
      funded_binding: fundedBindingFixture(TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE),
      tx_hash: `0x${'a'.repeat(64)}`,
    };
    mockedGetLatestTriggerByActionKey.mockResolvedValue(latest);
    const lockedActionKeys: string[] = [];
    const actionLock = {
      async withLock<T>(actionKey: string, work: () => Promise<T>): Promise<T> {
        lockedActionKeys.push(actionKey);
        return work();
      },
    };
    const sdkClient = {
      getDispatchSignerScope: jest
        .fn()
        .mockResolvedValue('31337:0x3333333333333333333333333333333333333333'),
      verifyDispatchFinality: jest.fn(),
      assertFundedBinding: jest.fn().mockResolvedValue(undefined),
      getTrade: jest.fn(),
      finalizeTrade: jest.fn(),
      isTradePaused: jest.fn().mockResolvedValue(false),
    } as unknown as TriggerManagerSdkClient;
    const manager = new TriggerManager(sdkClient, 3, 1, undefined, false, actionLock);

    const accepted = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-accepted',
      triggerType: TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE,
      fundedBinding: fundedBindingFixture(TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE),
    });
    await expect(
      manager.executeTrigger({
        tradeId: '1',
        requestId: 'req-deadline',
        triggerType: TriggerType.FINALIZE_TRADE,
        fundedBinding: fundedBindingFixture(TriggerType.FINALIZE_TRADE),
      }),
    ).rejects.toThrow('original funded progression instruction cannot be replaced');

    expect(lockedActionKeys).toEqual(['FINAL_RELEASE:1', 'FINAL_RELEASE:1']);
    expect(mockedGetLatestTriggerByActionKey).toHaveBeenCalledWith('FINAL_RELEASE:1');
    expect(accepted).toMatchObject({ idempotent: true, txHash: latest.tx_hash });
    expect(sdkClient.finalizeTrade).not.toHaveBeenCalled();
  });

  it('rejects Oracle inspection acceptance instead of broadcasting it', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue({
      ...buildTrigger(TriggerStatus.PENDING),
      action_key: 'FINAL_RELEASE:1',
      request_id: 'req-buyer-acceptance',
      idempotency_key: 'FINAL_RELEASE:1:req-buyer-acceptance',
      trigger_type: TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE,
      funded_binding: fundedBindingFixture(TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE),
    });
    const sdkClient = {
      getDispatchSignerScope: jest
        .fn()
        .mockResolvedValue('31337:0x3333333333333333333333333333333333333333'),
      verifyDispatchFinality: jest.fn(),
      assertFundedBinding: jest.fn().mockResolvedValue(undefined),
      getTrade: jest.fn().mockResolvedValue({
        ...buildTrade(2),
        arrivalTimestamp: new Date('2026-01-02T00:00:00.000Z'),
      }),
      finalizeTrade: jest.fn(),
      isTradePaused: jest.fn().mockResolvedValue(false),
    } as unknown as TriggerManagerSdkClient;
    const manager = new TriggerManager(sdkClient, 3, 1);

    const result = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-buyer-acceptance',
      triggerType: TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE,
      fundedBinding: fundedBindingFixture(TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE),
    });

    expect(result.status).toBe(TriggerStatus.TERMINAL_FAILURE);
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      'FINAL_RELEASE:1:req-buyer-acceptance',
      expect.objectContaining({
        status: TriggerStatus.TERMINAL_FAILURE,
        last_error: 'Oracle validation failure; detail is recorded on the trigger',
      }),
    );
    expect(sdkClient.finalizeTrade).not.toHaveBeenCalled();
  });

  it('retains an ambiguous send once without automatic retry', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue({
      ...buildTrigger(TriggerStatus.PENDING),
      request_id: 'req-retry',
    });

    const sdkClient: TriggerManagerSdkClient = {
      getDispatchSignerScope: jest
        .fn()
        .mockResolvedValue('31337:0x3333333333333333333333333333333333333333'),
      verifyDispatchFinality: jest.fn(),
      assertFundedBinding: jest.fn().mockResolvedValue(undefined),
      getTrade: jest.fn().mockResolvedValue(buildTrade(TRADE_STATUS_LOCKED)),
      releaseFundsStage1: jest
        .fn()
        .mockRejectedValue(new Error('timeout while sending transaction')),
      confirmInspectionAvailable: jest.fn(),
      finalizeTrade: jest.fn(),
      isTradePaused: jest.fn().mockResolvedValue(false),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 2, 1);
    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-retry',
      triggerType: TriggerType.RELEASE_STAGE_1,
      fundedBinding: fundedBindingFixture(TriggerType.RELEASE_STAGE_1),
    });

    expect(sdkClient.releaseFundsStage1).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(TriggerStatus.EXECUTING);
    expect(response.message).toContain('unresolved');
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: TriggerStatus.EXECUTING,
        last_error: expect.stringContaining('Resubmission is blocked'),
      }),
    );
    expect(mockedIncrementOracleExhaustedRetries).not.toHaveBeenCalled();
  });

  it('does not infer non-execution from a post-claim contract error', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue({
      ...buildTrigger(TriggerStatus.PENDING),
      request_id: 'req-terminal',
    });

    const sdkClient: TriggerManagerSdkClient = {
      getDispatchSignerScope: jest
        .fn()
        .mockResolvedValue('31337:0x3333333333333333333333333333333333333333'),
      verifyDispatchFinality: jest.fn(),
      assertFundedBinding: jest.fn().mockResolvedValue(undefined),
      getTrade: jest.fn().mockResolvedValue(buildTrade(TRADE_STATUS_LOCKED)),
      releaseFundsStage1: jest
        .fn()
        .mockRejectedValue(new Error('execution reverted: oracle disabled')),
      confirmInspectionAvailable: jest.fn(),
      finalizeTrade: jest.fn(),
      isTradePaused: jest.fn().mockResolvedValue(false),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 3, 1);
    const response = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-terminal',
      triggerType: TriggerType.RELEASE_STAGE_1,
      fundedBinding: fundedBindingFixture(TriggerType.RELEASE_STAGE_1),
    });

    expect(sdkClient.releaseFundsStage1).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(TriggerStatus.EXECUTING);
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: TriggerStatus.EXECUTING }),
    );
  });

  it('declines to submit and creates no trigger when the trade is admin-paused', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);

    const sdkClient: TriggerManagerSdkClient = {
      getDispatchSignerScope: jest
        .fn()
        .mockResolvedValue('31337:0x3333333333333333333333333333333333333333'),
      verifyDispatchFinality: jest.fn(),
      assertFundedBinding: jest.fn().mockResolvedValue(undefined),
      getTrade: jest.fn().mockResolvedValue(buildTrade(TRADE_STATUS_LOCKED)),
      releaseFundsStage1: jest.fn(),
      confirmInspectionAvailable: jest.fn(),
      finalizeTrade: jest.fn(),
      isTradePaused: jest.fn().mockResolvedValue(true),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 3, 1);

    await expect(
      manager.executeTrigger({
        tradeId: '1',
        requestId: 'req-paused',
        triggerType: TriggerType.RELEASE_STAGE_1,
        fundedBinding: fundedBindingFixture(TriggerType.RELEASE_STAGE_1),
      }),
    ).rejects.toThrow(/paused/);

    expect(sdkClient.isTradePaused).toHaveBeenCalledWith('1');
    expect(sdkClient.releaseFundsStage1).not.toHaveBeenCalled();
    expect(mockedCreateTrigger).not.toHaveBeenCalled();
  });

  it('declines a re-drive when the trade is admin-paused without marking it confirmed', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(
      buildTrigger(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE),
    );

    const sdkClient: TriggerManagerSdkClient = {
      getDispatchSignerScope: jest
        .fn()
        .mockResolvedValue('31337:0x3333333333333333333333333333333333333333'),
      verifyDispatchFinality: jest.fn(),
      assertFundedBinding: jest.fn().mockResolvedValue(undefined),
      getTrade: jest.fn().mockResolvedValue(buildTrade(TRADE_STATUS_LOCKED)),
      releaseFundsStage1: jest.fn(),
      confirmInspectionAvailable: jest.fn(),
      finalizeTrade: jest.fn(),
      isTradePaused: jest.fn().mockResolvedValue(true),
    } as unknown as TriggerManagerSdkClient;

    const manager = new TriggerManager(sdkClient, 3, 1);

    await expect(
      manager.executeTrigger({
        tradeId: '1',
        requestId: 'req-redrive-paused',
        triggerType: TriggerType.RELEASE_STAGE_1,
        fundedBinding: fundedBindingFixture(TriggerType.RELEASE_STAGE_1),
        isRedrive: true,
      }),
    ).rejects.toThrow(/paused/);

    expect(sdkClient.isTradePaused).toHaveBeenCalledWith('1');
    expect(sdkClient.releaseFundsStage1).not.toHaveBeenCalled();
    expect(mockedCreateTrigger).not.toHaveBeenCalled();
    // The re-drive catch must not misread the pause as "already executed on-chain".
    expect(mockedUpdateTrigger).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: TriggerStatus.CONFIRMED }),
    );
  });
  it('revalidates retained funding before retrying and never broadcasts after witness failure', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue(buildTrigger());
    const verifier = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('controlled original funding witness outage'));
    const send = jest.fn();
    const manager = new TriggerManager(
      {
        assertFundedBinding: verifier,
        getTrade: async () => buildTrade(),
        isTradePaused: async () => false,
        releaseFundsStage1: send,
      } as never,
      2,
      0,
    );
    const result = await manager.executeTrigger({
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
      fundedBinding: fundedBindingFixture(),
    });
    expect(result.status).toBe(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE);
    expect(send).not.toHaveBeenCalled();
  });
  it('persists an observed hash before a lost receipt response and retains the original after restart', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    mockedCreateTrigger.mockResolvedValue(buildTrigger());
    const hash = `0x${'d'.repeat(64)}`;
    const send = jest.fn(async (_id, observed) => {
      await observed(hash);
      throw new Error('controlled receipt timeout');
    });
    const manager = new TriggerManager(
      {
        getDispatchSignerScope: async () => '31337:0x3333333333333333333333333333333333333333',
        assertFundedBinding: async () => {},
        getTrade: async () => buildTrade(),
        isTradePaused: async () => false,
        releaseFundsStage1: send,
      } as never,
      5,
      0,
    );
    const req = {
      tradeId: '1',
      requestId: 'req-1',
      triggerType: TriggerType.RELEASE_STAGE_1,
      fundedBinding: fundedBindingFixture(),
    };
    const response = await manager.executeTrigger(req);
    expect(response).toMatchObject({ status: TriggerStatus.SUBMITTED, txHash: hash });
    expect(mockedUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tx_hash: hash,
        status: TriggerStatus.SUBMITTED,
        submitted_at: expect.any(Date),
      }),
    );
    mockedGetLatestTriggerByActionKey.mockResolvedValue({
      ...buildTrigger(TriggerStatus.EXECUTING),
      dispatch_started_at: new Date(),
    });
    expect((await manager.executeTrigger({ ...req, requestId: 'retry' })).status).toBe(
      TriggerStatus.EXECUTING,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects missing original scope and legacy recovery before making a new reservation', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(null);
    mockedGetTriggerByIdempotencyKey.mockResolvedValue(null);
    const manager = new TriggerManager({} as never);
    await expect(
      manager.executeTrigger({
        tradeId: '1',
        requestId: 'new',
        triggerType: TriggerType.RELEASE_STAGE_1,
      }),
    ).rejects.toThrow('original funded binding');
    expect(mockedCreateTrigger).not.toHaveBeenCalled();
  });
  it('does not reinterpret a changed trade state as successful original execution during re-drive', async () => {
    mockedGetLatestTriggerByActionKey.mockResolvedValue(
      buildTrigger(TriggerStatus.EXHAUSTED_NEEDS_REDRIVE),
    );
    const send = jest.fn();
    const manager = new TriggerManager(
      {
        assertFundedBinding: async () => {},
        isTradePaused: async () => false,
        getTrade: async () => buildTrade(1),
        releaseFundsStage1: send,
      } as never,
      1,
      0,
    );
    await expect(
      manager.executeTrigger({
        tradeId: '1',
        requestId: 'redrive',
        triggerType: TriggerType.RELEASE_STAGE_1,
        fundedBinding: fundedBindingFixture(),
        isRedrive: true,
      }),
    ).rejects.toThrow('expected LOCKED');
    expect(send).not.toHaveBeenCalled();
    expect(mockedUpdateTrigger).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: TriggerStatus.CONFIRMED }),
    );
  });
});
