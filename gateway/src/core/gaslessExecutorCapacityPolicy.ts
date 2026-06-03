/**
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GaslessExecutorCapacityPolicyInput {
  targetTransactionsPerDay: number;
  burstMultiplierBasisPoints: number;
  safetyMarginBasisPoints: number;
  maxCostPerTxWei: bigint;
  configuredMinExecutorBalanceWei: bigint;
  configuredLowBalanceAlertWei: bigint;
  failClosed: boolean;
}

export interface GaslessExecutorCapacityPolicy {
  targetTransactionsPerDay: number;
  averageTransactionsPerHour: number;
  burstTransactionsPerHour: number;
  burstMultiplierBasisPoints: number;
  safetyMarginBasisPoints: number;
  maxCostPerTxWei: string;
  requiredBurstHourBalanceWei: string;
  configuredMinExecutorBalanceWei: string;
  configuredLowBalanceAlertWei: string;
  floorMeetsPolicy: boolean;
  lowBalanceAlertProtectsPolicy: boolean;
  failClosed: boolean;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function calculateGaslessExecutorCapacityPolicy(
  input: GaslessExecutorCapacityPolicyInput,
): GaslessExecutorCapacityPolicy {
  assertPositiveInteger('targetTransactionsPerDay', input.targetTransactionsPerDay);
  assertPositiveInteger('burstMultiplierBasisPoints', input.burstMultiplierBasisPoints);
  assertPositiveInteger('safetyMarginBasisPoints', input.safetyMarginBasisPoints);

  const basisPoints = 10_000n;
  const averageTransactionsPerHour = Math.ceil(input.targetTransactionsPerDay / 24);
  const burstTransactionsPerHour = Number(
    ceilDiv(
      BigInt(input.targetTransactionsPerDay) * BigInt(input.burstMultiplierBasisPoints),
      24n * basisPoints,
    ),
  );
  const burstHourCostWei = input.maxCostPerTxWei * BigInt(burstTransactionsPerHour);
  const requiredBurstHourBalanceWei = ceilDiv(
    burstHourCostWei * BigInt(input.safetyMarginBasisPoints),
    basisPoints,
  );

  return {
    targetTransactionsPerDay: input.targetTransactionsPerDay,
    averageTransactionsPerHour,
    burstTransactionsPerHour,
    burstMultiplierBasisPoints: input.burstMultiplierBasisPoints,
    safetyMarginBasisPoints: input.safetyMarginBasisPoints,
    maxCostPerTxWei: input.maxCostPerTxWei.toString(),
    requiredBurstHourBalanceWei: requiredBurstHourBalanceWei.toString(),
    configuredMinExecutorBalanceWei: input.configuredMinExecutorBalanceWei.toString(),
    configuredLowBalanceAlertWei: input.configuredLowBalanceAlertWei.toString(),
    floorMeetsPolicy: input.configuredMinExecutorBalanceWei >= requiredBurstHourBalanceWei,
    lowBalanceAlertProtectsPolicy:
      input.configuredLowBalanceAlertWei > 0n &&
      input.configuredLowBalanceAlertWei >= requiredBurstHourBalanceWei,
    failClosed: input.failClosed,
  };
}
