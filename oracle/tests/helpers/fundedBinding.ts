import type { SettlementFundedBinding } from '@agroasys/sdk';
import { TriggerType } from '../../src/types/trigger';
/** Controlled chain scope for state-machine tests; not deployment evidence. */
export function fundedBindingFixture(
  triggerType: TriggerType = TriggerType.RELEASE_STAGE_1,
  tradeId = '1',
): SettlementFundedBinding {
  const phase =
    triggerType === TriggerType.RELEASE_STAGE_1
      ? 'initial_release_after_custody_and_documents'
      : triggerType === TriggerType.FINALIZE_TRADE
        ? 'final_release_after_notice_deadline'
        : triggerType === TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE
          ? 'final_release_after_inspection_acceptance'
          : triggerType === TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL
            ? 'inspection_available_packaged_local'
            : 'inspection_available_standard';
  return {
    scopeVersion: 'agroasys.funded-settlement-binding.v1',
    ownerServiceId: 'controlled-platform',
    sourceOperationId: '42',
    phase,
    chainId: '31337',
    escrowAddress: `0x${'1'.repeat(40)}`,
    tokenAddress: `0x${'2'.repeat(40)}`,
    tradeId,
    buyerAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    supplierAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    ricardianHash: `0x${'1'.repeat(64)}`,
    totalAmount: '1000',
    logisticsAmount: '100',
    platformFeesAmount: '50',
    supplierFirstTranche: '350',
    supplierSecondTranche: '500',
    supplierPayoutAmount: phase.startsWith('initial_')
      ? '350'
      : phase.startsWith('final_')
        ? '500'
        : '0',
    treasuryAccrualAmount: phase.startsWith('initial_') ? '150' : '0',
    buyerRefundAmount: '0',
    fundingTransactionHash: `0x${'a'.repeat(64)}`,
    fundingBlockNumber: '100',
    fundingBlockHash: `0x${'b'.repeat(64)}`,
    originalFundingFingerprint: 'c'.repeat(64),
  };
}
