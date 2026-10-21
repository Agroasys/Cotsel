/** SPDX-License-Identifier: Apache-2.0 */
import type { GaslessExecutorConfig } from '../gaslessExecutorConfig';
import type { UserActionCustodyPorts } from './custody';
/** Keeps dormant custody policy defaults aligned with the existing owning executors. */
export function bindUserActionCustodyPolicy(
  config: GaslessExecutorConfig,
  ports: Pick<UserActionCustodyPorts, 'provider' | 'nonces' | 'outcomes' | 'finality' | 'signer'>,
): UserActionCustodyPorts {
  return {
    ...ports,
    chainId: config.chainId,
    escrowAddress: config.escrowAddress,
    usdcAddress: config.usdcAddress,
    maxGasLimit: config.gaslessMaxGasLimit ?? 1_500_000n,
    maxFeePerGasWei: config.gaslessMaxFeePerGasWei ?? 50_000_000_000n,
    maxNativeCostWei: config.gaslessMaxNativeCostWei ?? 100_000_000_000_000_000n,
    minBalanceWei: config.gaslessMinExecutorBalanceWei ?? 0n,
    receiptTimeoutMs: config.gaslessReceiptTimeoutMs ?? 120_000,
  };
}
