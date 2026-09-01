/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GaslessExecutionReceipt } from './gaslessExecutionTypes';

export function serializeGasEstimate(
  value: bigint | string | number | null | undefined,
): string | null {
  return value === null || value === undefined ? null : BigInt(value).toString();
}

export function buildConfirmedMetadata(
  action: string,
  payloadHash: string,
  receipt: GaslessExecutionReceipt,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action,
    payloadHash,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPriceWei: receipt.effectiveGasPriceWei,
    nativeCostWei: receipt.nativeCostWei,
    executorAddress: receipt.executorAddress,
    executorBalanceWei: receipt.executorBalanceWei,
    ...extra,
  };
}
