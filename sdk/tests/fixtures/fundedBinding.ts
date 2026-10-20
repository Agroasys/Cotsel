import {
  parseSettlementFundedBinding,
  type SettlementFundedBinding,
} from '../../src/settlementFundedBinding';
export function fundedBindingFixture(
  overrides: Partial<SettlementFundedBinding> = {},
): SettlementFundedBinding {
  return parseSettlementFundedBinding({
    scopeVersion: 'agroasys.funded-settlement-binding.v1',
    ownerServiceId: 'controlled-platform',
    sourceOperationId: '42',
    phase: 'initial_release_after_custody_and_documents',
    chainId: '31337',
    escrowAddress: `0x${'1'.repeat(40)}`,
    tokenAddress: `0x${'2'.repeat(40)}`,
    tradeId: '1',
    buyerAddress: `0x${'3'.repeat(40)}`,
    supplierAddress: `0x${'4'.repeat(40)}`,
    ricardianHash: `0x${'5'.repeat(64)}`,
    totalAmount: '1000',
    logisticsAmount: '100',
    platformFeesAmount: '50',
    supplierFirstTranche: '350',
    supplierSecondTranche: '500',
    supplierPayoutAmount: '350',
    treasuryAccrualAmount: '150',
    buyerRefundAmount: '0',
    fundingTransactionHash: `0x${'a'.repeat(64)}`,
    fundingBlockNumber: '100',
    fundingBlockHash: `0x${'b'.repeat(64)}`,
    originalFundingFingerprint: 'c'.repeat(64),
    ...overrides,
  });
}
