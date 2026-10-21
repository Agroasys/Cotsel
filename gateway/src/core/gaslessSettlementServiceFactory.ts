import { createOwnedUserActionAdapter } from './userActionEngine/adapter';
import { createUserActionRetirementTransport } from './userActionEngine/retirementTransport';
import { createUserActionFundingVerifier } from './userActionFundingVerification';
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
import { createPostgresGaslessNonceReservationStore } from './gaslessNonceReservationStore';

export function createConfiguredGaslessSettlementService(
  config: GatewayConfig,
  pool: Pool,
  settlementService: SettlementService,
  settlementStore: SettlementStore,
  managedSignerValidationRecorder: ManagedSignerValidationRecorder,
  transactionOutcomeRecorder: GaslessTransactionOutcomeRecorder,
  retirementEvidence?: { url: string; owningServiceId: string },
): GaslessSettlementExecutionService | null {
  if (!config.gaslessExecutionEnabled) return null;

  const verifyUserActionFunding = createUserActionFundingVerifier(config);
  const verifyRetirement =
    retirementEvidence && config.settlementCallbackApiKey && config.settlementCallbackApiSecret
      ? createUserActionRetirementTransport({
          ...retirementEvidence,
          apiKey: config.settlementCallbackApiKey,
          apiSecret: config.settlementCallbackApiSecret,
          timeoutMs: Math.min(config.settlementCallbackRequestTimeoutMs, 9000),
        })
      : undefined;
  const userActionAdapter = createOwnedUserActionAdapter({
    pool,
    store: settlementStore,
    settlementService,
    verifyFunding: verifyUserActionFunding,
    verifyRetirement,
    chainId: config.chainId,
    escrowAddress: config.escrowAddress,
    usdcAddress: config.usdcAddress,
    requestMaxTtlSeconds: config.gaslessRequestMaxTtlSeconds ?? 900,
  });
  return new GaslessSettlementExecutionService(
    settlementService,
    settlementStore,
    createEthersGaslessSettlementExecutor(config, {
      userActionAdapter,
      verifyUserActionFunding,
      loadUserActionHandoff: (id) => settlementStore.getHandoff(id),
      recordValidationEvidence: managedSignerValidationRecorder,
      recordTransactionOutcome: transactionOutcomeRecorder,
      nonceReservationStore: createPostgresGaslessNonceReservationStore(pool),
    }),
    {
      userActionAdapter,
      verifyUserActionFunding,
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
