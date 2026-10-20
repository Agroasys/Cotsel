import type { GaslessCreateTradeExecutionInput } from '../../src/core/gaslessExecutionTypes';
import {
  parseSettlementExecutionBinding,
  type SettlementCreateTradeBinding,
} from '../../src/core/settlementExecutionBinding';
import {
  createGaslessExecutionScopeHash,
  normalizeCreateTradeInput,
} from '../../src/core/gaslessRequestNormalization';

// Controlled execution contract fixture; not provider or deployed-chain acceptance evidence.
export function executionBindingFixture(
  input: GaslessCreateTradeExecutionInput,
  ownerServiceId: string,
  tokenAddress: string,
) {
  const p = normalizeCreateTradeInput(input);
  return parseSettlementExecutionBinding(
    {
      scopeVersion: 'agroasys.cotsel-execution-binding.v1',
      sourceOperationId: 'controlled-operation',
      packageId: 'controlled-package',
      approvalScopeFingerprint: `0x${'a'.repeat(64)}`,
      chainId: String(p.chainId),
      escrowAddress: p.contractAddress,
      tokenAddress,
      buyerAddress: p.buyerAddress,
      supplierAddress: p.supplierAddress,
      ricardianHash: p.ricardianHash,
      totalAmount: p.totalAmount,
      logisticsAmount: p.logisticsAmount,
      platformFeesAmount: p.platformFeesAmount,
      supplierFirstTranche: p.supplierFirstTranche,
      supplierSecondTranche: p.supplierSecondTranche,
      expiresAt: p.expiresAt,
      buyerAuthorization: {
        nonce: p.buyerAuthorization.nonce,
        deadline: p.buyerAuthorization.deadline,
      },
      usdcAuthorization: {
        from: p.usdcAuthorization.from,
        to: p.usdcAuthorization.to,
        value: p.usdcAuthorization.value,
        validAfter: p.usdcAuthorization.validAfter,
        validBefore: p.usdcAuthorization.validBefore,
        nonce: p.usdcAuthorization.nonce,
      },
      executionScopeHash: createGaslessExecutionScopeHash(p),
    },
    ownerServiceId,
  ) as SettlementCreateTradeBinding;
}

export function fundedBindingFixture(phase = 'initial_release_after_custody_and_documents') {
  const first = phase.startsWith('initial_');
  const final = phase.startsWith('final_');
  return {
    scopeVersion: 'agroasys.funded-settlement-binding.v1' as const,
    ownerServiceId: 'platform-main',
    sourceOperationId: '42',
    phase,
    chainId: '31337',
    escrowAddress: `0x${'1'.repeat(40)}`,
    tokenAddress: `0x${'2'.repeat(40)}`,
    tradeId: '9001',
    buyerAddress: `0x${'3'.repeat(40)}`,
    supplierAddress: `0x${'4'.repeat(40)}`,
    ricardianHash: `0x${'5'.repeat(64)}`,
    totalAmount: '1000',
    logisticsAmount: '100',
    platformFeesAmount: '50',
    supplierFirstTranche: '350',
    supplierSecondTranche: '500',
    supplierPayoutAmount: first ? '350' : final ? '500' : '0',
    treasuryAccrualAmount: first ? '150' : '0',
    buyerRefundAmount: phase === 'dispute_resolution' ? '500' : '0',
    fundingTransactionHash: `0x${'a'.repeat(64)}`,
    fundingBlockNumber: '100',
    fundingBlockHash: `0x${'b'.repeat(64)}`,
    originalFundingFingerprint: 'c'.repeat(64),
  };
}
