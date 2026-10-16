import { ConfirmationWorker } from '../src/worker/confirmation-worker';
import { TriggerStatus, TriggerType } from '../src/types/trigger';
import { fundedBindingFixture } from './helpers/fundedBinding';
const mockGetTriggersByStatus = jest.fn();
const mockUpdateTrigger = jest.fn();
const mockResolveSignerDispatch = jest.fn();
jest.mock('../src/database/queries', () => ({
  getTriggersByStatus: (...args: unknown[]) => mockGetTriggersByStatus(...args),
  updateTrigger: (...args: unknown[]) => mockUpdateTrigger(...args),
  resolveSignerDispatch: (...args: unknown[]) => mockResolveSignerDispatch(...args),
}));
const hash = `0x${'a'.repeat(64)}`;
const scope = '31337:0x3333333333333333333333333333333333333333';
const trigger = {
  idempotency_key: 'operation',
  action_key: 'RELEASE_STAGE_1:1',
  request_id: 'req-1',
  tx_hash: hash,
  trade_id: '1',
  trigger_type: TriggerType.RELEASE_STAGE_1,
  submitted_at: new Date(Date.now() - 35 * 60 * 1000),
  dispatch_started_at: new Date(),
  dispatch_signer_scope: scope,
  funded_binding: fundedBindingFixture(),
};
const evidence = {
  policy: 'oracle_dispatch_nonce_finality_v1',
  signerScope: scope,
  transactionHash: hash,
  blockNumber: 100,
  blockHash: `0x${'b'.repeat(64)}`,
  receiptStatus: 1,
};
function setup(eventChanges: Record<string, unknown> = {}) {
  const sdk = {
    getTransactionReceiptBlockNumber: jest.fn().mockResolvedValue(null),
    getSettlementConfirmationHeads: jest.fn(),
    verifyProgressionReceipt: jest.fn().mockResolvedValue(evidence),
    getTrade: jest.fn().mockResolvedValue({ status: 4 }),
  };
  const indexer = {
    findConfirmationEvent: jest.fn().mockResolvedValue({
      id: 'event',
      txHash: hash,
      tradeId: '1',
      blockNumber: 100,
      eventName: 'FundsReleasedStage1',
      ...eventChanges,
    }),
  };
  const worker = new ConfirmationWorker(indexer as never, sdk as never);
  const check = (
    Reflect.get(worker, 'checkConfirmation') as (value: unknown) => Promise<void>
  ).bind(worker);
  return { sdk, indexer, check };
}
describe('Oracle independently finalized original confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSignerDispatch.mockResolvedValue(undefined);
  });
  it('confirms only the matching original finalized receipt and projection', async () => {
    const { sdk, check } = setup();
    await check(trigger);
    expect(sdk.verifyProgressionReceipt).toHaveBeenCalledWith(scope, hash, trigger.funded_binding);
    expect(mockResolveSignerDispatch).toHaveBeenCalledWith('operation', evidence);
    expect(mockUpdateTrigger).toHaveBeenCalledWith(
      'operation',
      expect.objectContaining({ status: TriggerStatus.CONFIRMED, confirmation_stage: 'FINALIZED' }),
    );
  });
  it.each([
    'missing receipt',
    'unfinalized',
    'RPC disagreement',
    'wrong recipient',
    'wrong input',
    'reverted',
  ])('retains %s even after timeout and advanced trade state', async (reason) => {
    const { sdk, check } = setup();
    sdk.verifyProgressionReceipt.mockRejectedValue(new Error(reason));
    await check(trigger);
    expect(mockUpdateTrigger).not.toHaveBeenCalled();
    expect(mockResolveSignerDispatch).not.toHaveBeenCalled();
    expect(sdk.getTrade).not.toHaveBeenCalled();
  });
  it.each([
    { txHash: `0x${'c'.repeat(64)}` },
    { tradeId: '2' },
    { blockNumber: 99 },
    { eventName: 'TradeLocked' },
  ])('rejects contradictory projection %j', async (changes) => {
    const { check } = setup(changes);
    await check(trigger);
    expect(mockUpdateTrigger).not.toHaveBeenCalled();
  });
  it('keeps legacy dispatches without signer attribution unresolved', async () => {
    const { sdk, check } = setup();
    await check({ ...trigger, dispatch_signer_scope: null });
    expect(sdk.verifyProgressionReceipt).not.toHaveBeenCalled();
    expect(mockUpdateTrigger).not.toHaveBeenCalled();
  });
  it('does not confirm if committing original nonce evidence fails', async () => {
    const { check } = setup();
    mockResolveSignerDispatch.mockRejectedValue(new Error('database unavailable'));
    await check(trigger);
    expect(mockUpdateTrigger).not.toHaveBeenCalled();
  });
});
