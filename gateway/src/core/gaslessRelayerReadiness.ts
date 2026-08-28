/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress } from 'ethers';
import { calculateGaslessExecutorCapacityPolicy } from './gaslessExecutorCapacityPolicy';
import type { GaslessRelayerReadinessSnapshot } from './gaslessExecutionTypes';

interface GaslessRelayerReadinessContext {
  options: {
    chainId: number;
    escrowAddress: string;
    broadcastPaused?: boolean;
    signerCustodyMode?: 'raw_private_key' | 'kms' | 'mpc';
    rpcFallbackCount?: number;
    gasLimitCap?: bigint;
    maxFeePerGasWei?: bigint;
    maxNativeCostWei?: bigint;
    minExecutorBalanceWei?: bigint;
    lowBalanceAlertWei?: bigint;
    capacityTargetTxPerDay?: number;
    capacityBurstMultiplierBasisPoints?: number;
    capacitySafetyMarginBasisPoints?: number;
    capacityRequiredExecutorBalanceWei?: bigint;
    capacityFailClosed?: boolean;
    stuckQueueThresholdMs?: number;
    receiptTimeoutMs?: number;
    repeatedFailureAlertThreshold?: number;
    now?: () => Date;
  };
  pendingBroadcastQueuedAtMs: number[];
  pendingBroadcasts: number;
  activeBroadcasts: number;
  lastQueueWaitMs: number | null;
  lastSubmissionAt: string | null;
  lastExecutorBalanceWei: bigint | null;
  repeatedFailureCount: number;
}

export function buildGaslessRelayerReadiness(
  context: GaslessRelayerReadinessContext,
): GaslessRelayerReadinessSnapshot {
  const alerts: GaslessRelayerReadinessSnapshot['alerts'] = [];
  const stuckQueueThresholdMs = context.options.stuckQueueThresholdMs ?? 300_000;
  const receiptTimeoutMs = context.options.receiptTimeoutMs ?? 120_000;
  const repeatedFailureAlertThreshold = context.options.repeatedFailureAlertThreshold ?? 3;
  const lowBalanceAlertWei = context.options.lowBalanceAlertWei ?? 0n;
  const gasLimitCap = context.options.gasLimitCap ?? 1_500_000n;
  const maxFeePerGasWei = context.options.maxFeePerGasWei ?? 50_000_000_000n;
  const maxNativeCostWei = context.options.maxNativeCostWei ?? 100_000_000_000_000_000n;
  const minExecutorBalanceWei = context.options.minExecutorBalanceWei ?? 0n;
  const oldestPendingBroadcastQueuedAtMs = context.pendingBroadcastQueuedAtMs[0] ?? null;
  const currentPendingQueueWaitMs =
    oldestPendingBroadcastQueuedAtMs === null
      ? null
      : Date.now() - oldestPendingBroadcastQueuedAtMs;
  const observableQueueWaitMs = Math.max(
    context.lastQueueWaitMs ?? 0,
    currentPendingQueueWaitMs ?? 0,
  );
  const capacityPolicy = calculateGaslessExecutorCapacityPolicy({
    targetTransactionsPerDay: context.options.capacityTargetTxPerDay ?? 500,
    burstMultiplierBasisPoints: context.options.capacityBurstMultiplierBasisPoints ?? 40_000,
    safetyMarginBasisPoints: context.options.capacitySafetyMarginBasisPoints ?? 12_500,
    maxCostPerTxWei: gasLimitCap * maxFeePerGasWei,
    configuredMinExecutorBalanceWei: minExecutorBalanceWei,
    configuredLowBalanceAlertWei: lowBalanceAlertWei,
    failClosed: context.options.capacityFailClosed ?? false,
  });
  const requiredExecutorBalanceWei =
    context.options.capacityRequiredExecutorBalanceWei ??
    BigInt(capacityPolicy.requiredBurstHourBalanceWei);

  if (context.options.broadcastPaused) {
    alerts.push({
      code: 'gasless_broadcast_paused',
      severity: 'high',
      detail: 'Gasless relayer broadcasts are paused by operator configuration.',
    });
  }

  if (context.pendingBroadcasts > 0 && observableQueueWaitMs >= stuckQueueThresholdMs) {
    alerts.push({
      code: 'gasless_queue_stuck',
      severity: 'high',
      detail: 'Gasless relayer queue wait time exceeded the stuck-queue threshold.',
    });
  }

  if (context.repeatedFailureCount >= repeatedFailureAlertThreshold) {
    alerts.push({
      code: 'gasless_repeated_failures',
      severity: 'high',
      detail: 'Gasless relayer has crossed the repeated-failure alert threshold.',
    });
  }

  if (
    context.lastExecutorBalanceWei !== null &&
    lowBalanceAlertWei > 0n &&
    context.lastExecutorBalanceWei <= lowBalanceAlertWei
  ) {
    alerts.push({
      code: 'gasless_low_executor_balance',
      severity: 'critical',
      detail: 'Gasless executor balance is at or below the configured low-balance alert threshold.',
    });
  }

  if (!capacityPolicy.floorMeetsPolicy) {
    alerts.push({
      code: 'gasless_executor_capacity_floor_below_policy',
      severity: capacityPolicy.failClosed ? 'critical' : 'medium',
      detail:
        'Configured executor balance floor does not cover the gasless burst-hour capacity policy.',
    });
  }

  if (!capacityPolicy.lowBalanceAlertProtectsPolicy) {
    alerts.push({
      code: 'gasless_executor_capacity_alert_below_policy',
      severity: capacityPolicy.failClosed ? 'critical' : 'medium',
      detail:
        'Configured low-balance alert threshold does not cover the gasless burst-hour capacity policy.',
    });
  }

  if (
    context.lastExecutorBalanceWei !== null &&
    context.lastExecutorBalanceWei < requiredExecutorBalanceWei
  ) {
    alerts.push({
      code: 'gasless_executor_balance_below_capacity_policy',
      severity: capacityPolicy.failClosed ? 'critical' : 'high',
      detail: 'Observed executor balance does not cover the gasless burst-hour capacity policy.',
    });
  }

  const hasCriticalCapacityAlert = alerts.some(
    (alert) =>
      alert.severity === 'critical' &&
      (alert.code === 'gasless_executor_capacity_floor_below_policy' ||
        alert.code === 'gasless_executor_capacity_alert_below_policy' ||
        alert.code === 'gasless_executor_balance_below_capacity_policy'),
  );
  const state: GaslessRelayerReadinessSnapshot['state'] = context.options.broadcastPaused
    ? 'paused'
    : hasCriticalCapacityAlert
      ? 'blocked'
      : alerts.some((alert) => alert.severity === 'critical' || alert.severity === 'high')
        ? 'degraded'
        : 'ready';

  return {
    enabled: true,
    paused: Boolean(context.options.broadcastPaused),
    state,
    generatedAt: (context.options.now?.() ?? new Date()).toISOString(),
    signerCustodyMode: context.options.signerCustodyMode ?? 'raw_private_key',
    activeExecutionPath: {
      chainId: context.options.chainId,
      escrowAddress: getAddress(context.options.escrowAddress),
      rpcFallbackCount: context.options.rpcFallbackCount ?? 0,
    },
    controls: {
      gasLimitCap: gasLimitCap.toString(),
      maxFeePerGasWei: maxFeePerGasWei.toString(),
      maxNativeCostWei: maxNativeCostWei.toString(),
      minExecutorBalanceWei: minExecutorBalanceWei.toString(),
      lowBalanceAlertWei: lowBalanceAlertWei.toString(),
      stuckQueueThresholdMs,
      receiptTimeoutMs,
      repeatedFailureAlertThreshold,
    },
    capacityPolicy,
    executorBalanceWei: context.lastExecutorBalanceWei?.toString() ?? null,
    queue: {
      pending: context.pendingBroadcasts,
      active: context.activeBroadcasts,
      lastQueueWaitMs: currentPendingQueueWaitMs ?? context.lastQueueWaitMs,
      lastSubmissionAt: context.lastSubmissionAt,
    },
    alerts,
    recentFailureCount: context.repeatedFailureCount,
  };
}
