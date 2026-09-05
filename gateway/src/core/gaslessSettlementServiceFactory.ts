/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import type { GatewayConfig } from '../config/gatewayConfig';
import type { ManagedSignerValidationRecorder } from './managedSignerIntentValidation';
import type { SettlementService } from './settlementService';
import type { SettlementStore } from './settlementStore';
import { createPostgresGaslessRelayerBroadcastLock } from './gaslessRelayerBroadcastLock';
import {
  createEthersGaslessSettlementExecutor,
  GaslessSettlementExecutionService,
} from './gaslessSettlementExecutionService';
import type { GaslessTransactionOutcomeRecorder } from './gaslessTransactionOutcomeStore';

export function createConfiguredGaslessSettlementService(
  config: GatewayConfig,
  pool: Pool,
  settlementService: SettlementService,
  settlementStore: SettlementStore,
  managedSignerValidationRecorder: ManagedSignerValidationRecorder,
  transactionOutcomeRecorder: GaslessTransactionOutcomeRecorder,
): GaslessSettlementExecutionService | null {
  if (!config.gaslessExecutionEnabled) return null;

  return new GaslessSettlementExecutionService(
    settlementService,
    settlementStore,
    createEthersGaslessSettlementExecutor(config, {
      recordValidationEvidence: managedSignerValidationRecorder,
      recordTransactionOutcome: transactionOutcomeRecorder,
    }),
    {
      chainId: config.chainId,
      escrowAddress: config.escrowAddress,
      usdcAddress: config.usdcAddress,
      requestMaxTtlSeconds: config.gaslessRequestMaxTtlSeconds ?? 900,
      broadcastPaused: config.gaslessBroadcastPaused,
      signerCustodyMode: config.gaslessSignerCustodyMode,
      rpcFallbackCount: config.rpcFallbackUrls.length,
      gasLimitCap: config.gaslessMaxGasLimit,
      maxFeePerGasWei: config.gaslessMaxFeePerGasWei,
      maxNativeCostWei: config.gaslessMaxNativeCostWei,
      minExecutorBalanceWei: config.gaslessMinExecutorBalanceWei,
      lowBalanceAlertWei: config.gaslessLowBalanceAlertWei,
      capacityTargetTxPerDay: config.gaslessCapacityTargetTxPerDay,
      capacityBurstMultiplierBasisPoints: config.gaslessCapacityBurstMultiplierBasisPoints,
      capacitySafetyMarginBasisPoints: config.gaslessCapacitySafetyMarginBasisPoints,
      capacityRequiredExecutorBalanceWei: config.gaslessCapacityRequiredExecutorBalanceWei,
      capacityFailClosed: config.gaslessCapacityFailClosed,
      stuckQueueThresholdMs: config.gaslessStuckQueueThresholdMs,
      receiptTimeoutMs: config.gaslessReceiptTimeoutMs,
      repeatedFailureAlertThreshold: config.gaslessRepeatedFailureAlertThreshold,
      broadcastLock: createPostgresGaslessRelayerBroadcastLock(pool),
    },
  );
}
