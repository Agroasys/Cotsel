import { ConfirmationWorker } from '../src/worker/confirmation-worker';
import { TriggerStatus, TriggerType } from '../src/types/trigger';

const mockGetTriggersByStatus = jest.fn();
const mockUpdateTrigger = jest.fn();
const TRADE_STATUS_LOCKED = 0;
const TRADE_STATUS_IN_TRANSIT = 1;

jest.mock('../src/database/queries', () => ({
  getTriggersByStatus: (...args: unknown[]) => mockGetTriggersByStatus(...args),
  updateTrigger: (...args: unknown[]) => mockUpdateTrigger(...args),
}));

type TriggerLike = {
  idempotency_key: string;
  action_key: string;
  request_id: string;
  tx_hash: string;
  trade_id: string;
  trigger_type: TriggerType;
  submitted_at: Date;
};

type IndexerClientLike = ConstructorParameters<typeof ConfirmationWorker>[0];
type SdkClientLike = ConstructorParameters<typeof ConfirmationWorker>[1];

function makeTrigger(overrides: Partial<TriggerLike> = {}): TriggerLike {
  return {
    idempotency_key: 'idem-1234567890abcdef1234567890abcdef',
    action_key: 'RELEASE_STAGE_1:1',
    request_id: 'req-1',
    tx_hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    trade_id: '1',
    trigger_type: TriggerType.RELEASE_STAGE_1,
    submitted_at: new Date(Date.now() - 25 * 60 * 1000),
    ...overrides,
  };
}

describe('ConfirmationWorker on-chain fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks trigger confirmed when indexer is unavailable but chain state has advanced', async () => {
    const indexerClient: IndexerClientLike = {
      findConfirmationEvent: jest.fn().mockResolvedValue(null),
    } as unknown as IndexerClientLike;

    const sdkClient: SdkClientLike = {
      getTransactionReceiptBlockNumber: jest.fn().mockResolvedValue(null),
      getSettlementConfirmationHeads: jest.fn(),
      getTrade: jest.fn().mockResolvedValue({ status: TRADE_STATUS_IN_TRANSIT }),
    } as unknown as SdkClientLike;

    const worker = new ConfirmationWorker(indexerClient, sdkClient);
    const checkConfirmation = Reflect.get(worker, 'checkConfirmation') as (
      trigger: TriggerLike,
    ) => Promise<void>;
    const boundCheckConfirmation = checkConfirmation.bind(worker);

    await boundCheckConfirmation(makeTrigger());

    expect(sdkClient.getTrade).toHaveBeenCalledWith('1');
    expect(mockUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: TriggerStatus.CONFIRMED,
        on_chain_verified: true,
      }),
    );
  });

  it('does not mark confirmed when chain state is still pending', async () => {
    const indexerClient: IndexerClientLike = {
      findConfirmationEvent: jest.fn().mockResolvedValue(null),
    } as unknown as IndexerClientLike;

    const sdkClient: SdkClientLike = {
      getTransactionReceiptBlockNumber: jest.fn().mockResolvedValue(null),
      getSettlementConfirmationHeads: jest.fn(),
      getTrade: jest.fn().mockResolvedValue({ status: TRADE_STATUS_LOCKED }),
    } as unknown as SdkClientLike;

    const worker = new ConfirmationWorker(indexerClient, sdkClient);
    const checkConfirmation = Reflect.get(worker, 'checkConfirmation') as (
      trigger: TriggerLike,
    ) => Promise<void>;
    const boundCheckConfirmation = checkConfirmation.bind(worker);

    await boundCheckConfirmation(makeTrigger());

    expect(sdkClient.getTrade).toHaveBeenCalledWith('1');
    expect(mockUpdateTrigger).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: TriggerStatus.CONFIRMED }),
    );
  });

  it('rate-limits on-chain fallback checks per tradeId', async () => {
    const indexerClient: IndexerClientLike = {
      findConfirmationEvent: jest.fn().mockResolvedValue(null),
    } as unknown as IndexerClientLike;

    const sdkClient: SdkClientLike = {
      getTransactionReceiptBlockNumber: jest.fn().mockResolvedValue(null),
      getSettlementConfirmationHeads: jest.fn(),
      getTrade: jest.fn().mockResolvedValue({ status: TRADE_STATUS_LOCKED }),
    } as unknown as SdkClientLike;

    const worker = new ConfirmationWorker(indexerClient, sdkClient);
    const checkConfirmation = Reflect.get(worker, 'checkConfirmation') as (
      trigger: TriggerLike,
    ) => Promise<void>;
    const boundCheckConfirmation = checkConfirmation.bind(worker);
    const trigger = makeTrigger();

    await boundCheckConfirmation(trigger);
    await boundCheckConfirmation(trigger);

    expect(sdkClient.getTrade).toHaveBeenCalledTimes(1);
  });

  it('confirms from receipt once the block has reached the safe stage', async () => {
    const indexerClient: IndexerClientLike = {
      findConfirmationEvent: jest.fn().mockResolvedValue(null),
    } as unknown as IndexerClientLike;

    const sdkClient: SdkClientLike = {
      getTransactionReceiptBlockNumber: jest.fn().mockResolvedValue(123),
      getSettlementConfirmationHeads: jest.fn().mockResolvedValue({
        latestBlockNumber: 140,
        safeBlockNumber: 130,
        finalizedBlockNumber: 100,
      }),
      getTrade: jest.fn(),
    } as unknown as SdkClientLike;

    const worker = new ConfirmationWorker(indexerClient, sdkClient);
    const checkConfirmation = Reflect.get(worker, 'checkConfirmation') as (
      trigger: TriggerLike,
    ) => Promise<void>;
    const boundCheckConfirmation = checkConfirmation.bind(worker);

    await boundCheckConfirmation(
      makeTrigger({ submitted_at: new Date(Date.now() - 35 * 60 * 1000) }),
    );

    expect(mockUpdateTrigger).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: TriggerStatus.CONFIRMED,
        on_chain_verified: true,
        confirmation_stage: 'SAFE',
      }),
    );
    expect(sdkClient.getTrade).not.toHaveBeenCalled();
  });
});
