/** SPDX-License-Identifier: Apache-2.0 */
import { getAddress } from 'ethers';
import type { Trade } from './types/trade';

export const FUNDED_SETTLEMENT_PHASES = [
  'initial_release_after_custody_and_documents',
  'inspection_available_standard',
  'inspection_available_packaged_local',
  'final_release_after_inspection_acceptance',
  'final_release_after_notice_deadline',
  'dispute_resolution',
] as const;
/** Immutable original trade and approved progression instruction. No signature format changes. */
export interface SettlementFundedBinding {
  scopeVersion: 'agroasys.funded-settlement-binding.v1';
  ownerServiceId: string;
  sourceOperationId: string;
  phase: (typeof FUNDED_SETTLEMENT_PHASES)[number];
  chainId: string;
  escrowAddress: string;
  tokenAddress: string;
  tradeId: string;
  buyerAddress: string;
  supplierAddress: string;
  ricardianHash: string;
  totalAmount: string;
  logisticsAmount: string;
  platformFeesAmount: string;
  supplierFirstTranche: string;
  supplierSecondTranche: string;
  supplierPayoutAmount: string;
  treasuryAccrualAmount: string;
  buyerRefundAmount: string;
  fundingTransactionHash: string;
  fundingBlockNumber: string;
  fundingBlockHash: string;
  originalFundingFingerprint: string;
}
const fields = [
  'scopeVersion',
  'ownerServiceId',
  'sourceOperationId',
  'phase',
  'chainId',
  'escrowAddress',
  'tokenAddress',
  'tradeId',
  'buyerAddress',
  'supplierAddress',
  'ricardianHash',
  'totalAmount',
  'logisticsAmount',
  'platformFeesAmount',
  'supplierFirstTranche',
  'supplierSecondTranche',
  'supplierPayoutAmount',
  'treasuryAccrualAmount',
  'buyerRefundAmount',
  'fundingTransactionHash',
  'fundingBlockNumber',
  'fundingBlockHash',
  'originalFundingFingerprint',
] as const;
const invalid = (): never => {
  throw new Error('A complete immutable funded settlement binding is required');
};
export function parseSettlementFundedBinding(value: unknown): SettlementFundedBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== fields.length ||
    Object.keys(row).some((key) => !fields.includes(key as (typeof fields)[number])) ||
    fields.some((key) => typeof row[key] !== 'string') ||
    row.scopeVersion !== 'agroasys.funded-settlement-binding.v1' ||
    !FUNDED_SETTLEMENT_PHASES.includes(row.phase as SettlementFundedBinding['phase'])
  )
    return invalid();
  const result = Object.fromEntries(
    fields.map((key) => [key, row[key]]),
  ) as unknown as SettlementFundedBinding;
  for (const key of ['ownerServiceId', 'sourceOperationId'] as const)
    if (!result[key] || result[key].trim() !== result[key] || result[key].length > 128)
      return invalid();
  for (const key of [
    'chainId',
    'tradeId',
    'totalAmount',
    'logisticsAmount',
    'platformFeesAmount',
    'supplierFirstTranche',
    'supplierSecondTranche',
    'supplierPayoutAmount',
    'treasuryAccrualAmount',
    'buyerRefundAmount',
    'fundingBlockNumber',
  ] as const)
    if (!/^(0|[1-9]\d{0,77})$/.test(result[key]) || BigInt(result[key]) > (1n << 256n) - 1n)
      return invalid();
  if (
    BigInt(result.chainId) <= 0n ||
    BigInt(result.chainId) > BigInt(Number.MAX_SAFE_INTEGER) ||
    BigInt(result.totalAmount) <= 0n
  )
    return invalid();
  for (const key of ['escrowAddress', 'tokenAddress', 'buyerAddress', 'supplierAddress'] as const) {
    try {
      result[key] = getAddress(result[key]).toLowerCase();
    } catch {
      return invalid();
    }
    if (/^0x0{40}$/.test(result[key])) return invalid();
  }
  for (const key of ['ricardianHash', 'fundingTransactionHash', 'fundingBlockHash'] as const) {
    if (!/^0x[0-9a-f]{64}$/i.test(result[key])) return invalid();
    result[key] = result[key].toLowerCase();
  }
  if (
    !/^[0-9a-f]{64}$/.test(result.originalFundingFingerprint) ||
    BigInt(result.totalAmount) !==
      BigInt(result.logisticsAmount) +
        BigInt(result.platformFeesAmount) +
        BigInt(result.supplierFirstTranche) +
        BigInt(result.supplierSecondTranche)
  )
    return invalid();
  const amounts = [
    BigInt(result.supplierPayoutAmount),
    BigInt(result.treasuryAccrualAmount),
    BigInt(result.buyerRefundAmount),
  ];
  const first = result.phase === 'initial_release_after_custody_and_documents';
  const final =
    result.phase === 'final_release_after_inspection_acceptance' ||
    result.phase === 'final_release_after_notice_deadline';
  const inspection = result.phase.startsWith('inspection_available_');
  if (
    (first &&
      (amounts[0] !== BigInt(result.supplierFirstTranche) ||
        amounts[1] !== BigInt(result.logisticsAmount) + BigInt(result.platformFeesAmount) ||
        amounts[2] !== 0n)) ||
    (final &&
      (amounts[0] !== BigInt(result.supplierSecondTranche) ||
        amounts[1] !== 0n ||
        amounts[2] !== 0n)) ||
    (inspection && amounts.some((amount) => amount !== 0n)) ||
    (result.phase === 'dispute_resolution' &&
      (amounts[1] !== 0n || amounts[0] + amounts[2] !== BigInt(result.supplierSecondTranche)))
  )
    return invalid();
  return result;
}

/** Called again immediately before submission, including restarted retries and approved re-drives. */
export function assertFundedTradeMatchesBinding(
  trade: Trade,
  value: SettlementFundedBinding,
): void {
  const binding = parseSettlementFundedBinding(value);
  if (
    trade.tradeId !== binding.tradeId ||
    trade.buyer.toLowerCase() !== binding.buyerAddress ||
    trade.supplier.toLowerCase() !== binding.supplierAddress ||
    trade.ricardianHash.toLowerCase() !== binding.ricardianHash ||
    trade.totalAmountLocked.toString() !== binding.totalAmount ||
    trade.logisticsAmount.toString() !== binding.logisticsAmount ||
    trade.platformFeesAmount.toString() !== binding.platformFeesAmount ||
    trade.supplierFirstTranche.toString() !== binding.supplierFirstTranche ||
    trade.supplierSecondTranche.toString() !== binding.supplierSecondTranche
  )
    throw new Error('The on-chain trade differs from its immutable original funding binding');
}
