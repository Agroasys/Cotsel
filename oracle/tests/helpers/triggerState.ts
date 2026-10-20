import type { TriggerManager } from '../../src/core/trigger-manager';
import { ErrorType, Trigger, TriggerStatus, TriggerType } from '../../src/types/trigger';
import { fundedBindingFixture } from './fundedBinding';
type TriggerManagerSdkClient = ConstructorParameters<typeof TriggerManager>[0];
type TradeRecord = Awaited<ReturnType<TriggerManagerSdkClient['getTrade']>>;

export function buildTrade(status: number = 0): TradeRecord {
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

export function buildTrigger(status: TriggerStatus = TriggerStatus.PENDING): Trigger {
  return {
    id: 1,
    action_key: 'RELEASE_STAGE_1:1',
    request_id: 'req-1',
    idempotency_key: 'RELEASE_STAGE_1:1:req-1',
    trade_id: '1',
    trigger_type: TriggerType.RELEASE_STAGE_1,
    funded_binding: fundedBindingFixture(TriggerType.RELEASE_STAGE_1),
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
