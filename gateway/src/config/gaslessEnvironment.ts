/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { strict as assert } from 'assert';
import { getAddress } from 'ethers';
import { calculateGaslessExecutorCapacityPolicy } from '../core/gaslessExecutorCapacityPolicy';
import type { GatewayConfig } from './gatewayConfig';
import {
  parseGaslessSignerCustodyMode,
  validateGaslessSignerCustodyConfig,
} from './gaslessSignerCustodyMode';
import {
  assertPrivateKey,
  envBigInt,
  envBool,
  envNumber,
  envPositiveInteger,
  optionalEnv,
} from './envReaders';

type GaslessGatewayConfig = Pick<
  GatewayConfig,
  | 'gaslessExecutionEnabled'
  | 'gaslessExecutorPrivateKey'
  | 'gaslessSignerCustodyMode'
  | 'gaslessKmsKeyId'
  | 'gaslessKmsExpectedAddress'
  | 'gaslessManagedSignerUrl'
  | 'gaslessManagedSignerApiKey'
  | 'gaslessManagedSignerRequestTimeoutMs'
  | 'gaslessBroadcastPaused'
  | 'gaslessMaxGasLimit'
  | 'gaslessMaxFeePerGasWei'
  | 'gaslessMaxNativeCostWei'
  | 'gaslessMinExecutorBalanceWei'
  | 'gaslessLowBalanceAlertWei'
  | 'gaslessCapacityTargetTxPerDay'
  | 'gaslessCapacityBurstMultiplierBasisPoints'
  | 'gaslessCapacitySafetyMarginBasisPoints'
  | 'gaslessCapacityRequiredExecutorBalanceWei'
  | 'gaslessCapacityFailClosed'
  | 'gaslessRequestMaxTtlSeconds'
  | 'gaslessStuckQueueThresholdMs'
  | 'gaslessReceiptTimeoutMs'
  | 'gaslessOutcomeReconciliationIntervalMs'
  | 'gaslessRepeatedFailureAlertThreshold'
  | 'gaslessRequireRpcFallback'
>;

export function loadGaslessEnvironment({
  chainId,
  nodeEnv,
  rpcFallbackUrls,
}: {
  chainId: number;
  nodeEnv: string;
  rpcFallbackUrls: string[];
}): GaslessGatewayConfig {
  const gaslessExecutionEnabled = envBool('GATEWAY_GASLESS_EXECUTION_ENABLED', false);
  const gaslessSignerCustodyMode = parseGaslessSignerCustodyMode(
    process.env.GATEWAY_GASLESS_SIGNER_CUSTODY_MODE,
  );
  const gaslessBroadcastPaused = envBool('GATEWAY_GASLESS_BROADCAST_PAUSED', false);
  const gaslessRequireRpcFallback = envBool(
    'GATEWAY_GASLESS_REQUIRE_RPC_FALLBACK',
    nodeEnv === 'production',
  );
  const gaslessExecutorPrivateKey = assertPrivateKey(
    'GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY',
    process.env.GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY?.trim() ||
      process.env.GATEWAY_EXECUTOR_PRIVATE_KEY?.trim() ||
      undefined,
  );
  const gaslessKmsKeyId = optionalEnv('GATEWAY_GASLESS_KMS_KEY_ID');
  const gaslessKmsExpectedAddress = optionalEnv('GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS');
  const gaslessManagedSignerUrl =
    process.env.GATEWAY_GASLESS_MANAGED_SIGNER_URL?.trim()?.replace(/\/$/, '') || undefined;
  const gaslessManagedSignerApiKey =
    process.env.GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY?.trim() || undefined;
  const gaslessMaxGasLimit = envBigInt('GATEWAY_GASLESS_MAX_GAS_LIMIT', 1_500_000n);
  const gaslessMaxFeePerGasWei = envBigInt('GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI', 50_000_000_000n);
  const gaslessMaxNativeCostWei = envBigInt(
    'GATEWAY_GASLESS_MAX_NATIVE_COST_WEI',
    100_000_000_000_000_000n,
  );
  const gaslessMinExecutorBalanceWei = envBigInt('GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI', 0n);
  const gaslessLowBalanceAlertWei = envBigInt('GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI', 0n);
  const gaslessCapacityTargetTxPerDay = envPositiveInteger(
    'GATEWAY_GASLESS_CAPACITY_TARGET_TX_PER_DAY',
    500,
  );
  const gaslessCapacityBurstMultiplierBasisPoints = envPositiveInteger(
    'GATEWAY_GASLESS_CAPACITY_BURST_MULTIPLIER_BASIS_POINTS',
    40_000,
  );
  const gaslessCapacitySafetyMarginBasisPoints = envPositiveInteger(
    'GATEWAY_GASLESS_CAPACITY_SAFETY_MARGIN_BASIS_POINTS',
    12_500,
  );
  const gaslessCapacityFailClosed = envBool(
    'GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED',
    nodeEnv === 'production' || chainId === 8453,
  );
  const capacityPolicy = calculateGaslessExecutorCapacityPolicy({
    targetTransactionsPerDay: gaslessCapacityTargetTxPerDay,
    burstMultiplierBasisPoints: gaslessCapacityBurstMultiplierBasisPoints,
    safetyMarginBasisPoints: gaslessCapacitySafetyMarginBasisPoints,
    maxCostPerTxWei: gaslessMaxGasLimit * gaslessMaxFeePerGasWei,
    configuredMinExecutorBalanceWei: gaslessMinExecutorBalanceWei,
    configuredLowBalanceAlertWei: gaslessLowBalanceAlertWei,
    failClosed: gaslessCapacityFailClosed,
  });

  assert(
    envNumber('GATEWAY_GASLESS_REQUEST_MAX_TTL_SECONDS', 900) >= 30,
    'GATEWAY_GASLESS_REQUEST_MAX_TTL_SECONDS must be >= 30',
  );
  assert(
    envNumber('GATEWAY_GASLESS_MANAGED_SIGNER_REQUEST_TIMEOUT_MS', 5000) >= 1000,
    'GATEWAY_GASLESS_MANAGED_SIGNER_REQUEST_TIMEOUT_MS must be >= 1000',
  );
  assert(
    envNumber('GATEWAY_GASLESS_RECEIPT_TIMEOUT_MS', 120000) >= 1000,
    'GATEWAY_GASLESS_RECEIPT_TIMEOUT_MS must be >= 1000',
  );
  assert(
    envNumber('GATEWAY_GASLESS_OUTCOME_RECONCILIATION_INTERVAL_MS', 5000) >= 1000,
    'GATEWAY_GASLESS_OUTCOME_RECONCILIATION_INTERVAL_MS must be >= 1000',
  );

  if (gaslessManagedSignerUrl) {
    assert(
      gaslessManagedSignerUrl.startsWith('http://') ||
        gaslessManagedSignerUrl.startsWith('https://'),
      'GATEWAY_GASLESS_MANAGED_SIGNER_URL must be an absolute http(s) URL',
    );
  }

  if (gaslessExecutionEnabled) {
    validateGaslessSignerCustodyConfig({
      enabled: true,
      mode: gaslessSignerCustodyMode,
      executorPrivateKey: gaslessExecutorPrivateKey,
      kmsKeyId: gaslessKmsKeyId,
      kmsExpectedAddress: gaslessKmsExpectedAddress,
      managedSignerUrl: gaslessManagedSignerUrl,
      managedSignerApiKey: gaslessManagedSignerApiKey,
    });
    assert(
      gaslessMaxFeePerGasWei > 0n,
      'GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI must be > 0 when gasless execution is enabled',
    );
    assert(
      gaslessMaxNativeCostWei > 0n,
      'GATEWAY_GASLESS_MAX_NATIVE_COST_WEI must be > 0 when gasless execution is enabled',
    );
    assert(
      gaslessLowBalanceAlertWei === 0n ||
        gaslessMinExecutorBalanceWei === 0n ||
        gaslessLowBalanceAlertWei >= gaslessMinExecutorBalanceWei,
      'GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI must be >= GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI when both are set',
    );
    assert(
      gaslessCapacityTargetTxPerDay > 0,
      'GATEWAY_GASLESS_CAPACITY_TARGET_TX_PER_DAY must be > 0',
    );
    assert(
      gaslessCapacityBurstMultiplierBasisPoints > 0,
      'GATEWAY_GASLESS_CAPACITY_BURST_MULTIPLIER_BASIS_POINTS must be > 0',
    );
    assert(
      gaslessCapacitySafetyMarginBasisPoints >= 10_000,
      'GATEWAY_GASLESS_CAPACITY_SAFETY_MARGIN_BASIS_POINTS must be >= 10000',
    );
    if (gaslessCapacityFailClosed) {
      assert(
        capacityPolicy.floorMeetsPolicy,
        'GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI must cover the configured gasless burst-hour capacity policy when fail-closed capacity is enabled',
      );
      assert(
        capacityPolicy.lowBalanceAlertProtectsPolicy,
        'GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI must cover the configured gasless burst-hour capacity policy when fail-closed capacity is enabled',
      );
    }
    assert(
      envNumber('GATEWAY_GASLESS_STUCK_QUEUE_THRESHOLD_MS', 300000) >= 1000,
      'GATEWAY_GASLESS_STUCK_QUEUE_THRESHOLD_MS must be >= 1000',
    );
    assert(
      envNumber('GATEWAY_GASLESS_REPEATED_FAILURE_ALERT_THRESHOLD', 3) >= 1,
      'GATEWAY_GASLESS_REPEATED_FAILURE_ALERT_THRESHOLD must be >= 1',
    );
    if (nodeEnv === 'production') {
      assert(
        gaslessSignerCustodyMode !== 'raw_private_key',
        'Production gasless execution must use KMS/MPC signer custody; raw private-key gasless custody is not allowed',
      );
    }
    if (gaslessRequireRpcFallback) {
      assert(
        rpcFallbackUrls.length > 0,
        'GATEWAY_GASLESS_REQUIRE_RPC_FALLBACK requires at least one GATEWAY_RPC_FALLBACK_URLS entry',
      );
    }
  }

  return {
    gaslessExecutionEnabled,
    gaslessExecutorPrivateKey,
    gaslessSignerCustodyMode,
    gaslessKmsKeyId,
    gaslessKmsExpectedAddress: gaslessKmsExpectedAddress
      ? getAddress(gaslessKmsExpectedAddress)
      : undefined,
    gaslessManagedSignerUrl,
    gaslessManagedSignerApiKey,
    gaslessManagedSignerRequestTimeoutMs: envNumber(
      'GATEWAY_GASLESS_MANAGED_SIGNER_REQUEST_TIMEOUT_MS',
      5000,
    ),
    gaslessBroadcastPaused,
    gaslessMaxGasLimit,
    gaslessMaxFeePerGasWei,
    gaslessMaxNativeCostWei,
    gaslessMinExecutorBalanceWei,
    gaslessLowBalanceAlertWei,
    gaslessCapacityTargetTxPerDay,
    gaslessCapacityBurstMultiplierBasisPoints,
    gaslessCapacitySafetyMarginBasisPoints,
    gaslessCapacityRequiredExecutorBalanceWei: BigInt(capacityPolicy.requiredBurstHourBalanceWei),
    gaslessCapacityFailClosed,
    gaslessRequestMaxTtlSeconds: envNumber('GATEWAY_GASLESS_REQUEST_MAX_TTL_SECONDS', 900),
    gaslessStuckQueueThresholdMs: envNumber('GATEWAY_GASLESS_STUCK_QUEUE_THRESHOLD_MS', 300000),
    gaslessReceiptTimeoutMs: envNumber('GATEWAY_GASLESS_RECEIPT_TIMEOUT_MS', 120000),
    gaslessOutcomeReconciliationIntervalMs: envNumber(
      'GATEWAY_GASLESS_OUTCOME_RECONCILIATION_INTERVAL_MS',
      5000,
    ),
    gaslessRepeatedFailureAlertThreshold: envNumber(
      'GATEWAY_GASLESS_REPEATED_FAILURE_ALERT_THRESHOLD',
      3,
    ),
    gaslessRequireRpcFallback,
  };
}
