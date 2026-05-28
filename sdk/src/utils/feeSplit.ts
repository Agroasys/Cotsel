/**
 * SPDX-License-Identifier: Apache-2.0
 */

export const SETTLEMENT_SUPPORT_FEE_BASE_UNITS = 4_000_000n;

export interface PlatformFeeSplit {
  platformFeeNetAmount: bigint;
  settlementSupportFeeAmount: bigint;
}

export function splitPlatformFeeComponents(platformFeesAmount: bigint): PlatformFeeSplit {
  if (platformFeesAmount < 0n) {
    throw new Error('platformFeesAmount cannot be negative');
  }

  const settlementSupportFeeAmount =
    platformFeesAmount < SETTLEMENT_SUPPORT_FEE_BASE_UNITS
      ? platformFeesAmount
      : SETTLEMENT_SUPPORT_FEE_BASE_UNITS;

  return {
    platformFeeNetAmount: platformFeesAmount - settlementSupportFeeAmount,
    settlementSupportFeeAmount,
  };
}
