import type { RetainedSettlementRail } from './retainedSettlementRails';
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SettlementRuntimeKey } from '@agroasys/sdk';

export interface GatewayConfig {
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbMigrationUser?: string;
  dbMigrationPassword?: string;
  dbSslMode?: 'disable' | 'require' | 'verify-full';
  authBaseUrl: string;
  authRequestTimeoutMs: number;
  indexerGraphqlUrl: string;
  indexerCoverageUrl?: string;
  retainedSettlementRails?: RetainedSettlementRail[];
  reconciliationCoverageUrl?: string;
  indexerRequestTimeoutMs: number;
  rpcUrl: string;
  rpcFallbackUrls: string[];
  rpcReadTimeoutMs: number;
  rpcQuorum?: number;
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  settlementRuntimeKey?: SettlementRuntimeKey;
  networkName?: string;
  explorerBaseUrl?: string | null;
  contractAddressRequired: boolean;
  operatorSignerEnvironment?: string;
  enableMutations: boolean;
  writeAllowlist: string[];
  governancePreparationTtlSeconds?: number;
  /**
   * Privileged mutations require an upstream step-up at most this many seconds
   * old (Cotsel#946). Defaults: 300 seconds, hardware WebAuthn, enforce.
   */
  stepUpMaxAgeSeconds?: number;
  stepUpAcceptedStrengths?: string[];
  /** `record` logs and audits a stale step-up but lets the request through (rollback only). */
  stepUpEnforcement?: 'enforce' | 'record';
  /** @deprecated Compatibility alias for legacy in-process test fixtures only. */
  governanceQueueTtlSeconds?: number;
  settlementIngressEnabled: boolean;
  immediateInspectionAcceptanceEnabled?: boolean;
  settlementServiceAuthApiKeysJson: string;
  settlementServiceAuthSharedSecret?: string;
  settlementServiceAuthMaxSkewSeconds: number;
  settlementServiceAuthNonceTtlSeconds: number;
  settlementCallbackEnabled: boolean;
  settlementCallbackUrl?: string;
  settlementCallbackApiKey?: string;
  settlementCallbackApiSecret?: string;
  userActionRetirementEvidenceUrl?: string;
  userActionRetirementOwningServiceId?: string;
  settlementCallbackRequestTimeoutMs: number;
  settlementCallbackPollIntervalMs: number;
  settlementCallbackMaxAttempts: number;
  settlementCallbackInitialBackoffMs: number;
  settlementCallbackMaxBackoffMs: number;
  idempotencyLeaseDurationMs?: number;
  gaslessExecutionEnabled?: boolean;
  gaslessExecutorPrivateKey?: string;
  gaslessSignerCustodyMode?: 'raw_private_key' | 'kms' | 'mpc';
  gaslessKmsKeyId?: string;
  gaslessKmsExpectedAddress?: string;
  gaslessManagedSignerUrl?: string;
  gaslessManagedSignerApiKey?: string;
  gaslessManagedSignerApiSecret?: string;
  gaslessManagedSignerRequestTimeoutMs?: number;
  gaslessBroadcastPaused?: boolean;
  gaslessMaxGasLimit?: bigint;
  gaslessMaxFeePerGasWei?: bigint;
  gaslessMaxNativeCostWei?: bigint;
  gaslessMinExecutorBalanceWei?: bigint;
  gaslessLowBalanceAlertWei?: bigint;
  gaslessCapacityTargetTxPerDay?: number;
  gaslessCapacityBurstMultiplierBasisPoints?: number;
  gaslessCapacitySafetyMarginBasisPoints?: number;
  gaslessCapacityRequiredExecutorBalanceWei?: bigint;
  gaslessCapacityFailClosed?: boolean;
  gaslessRequestMaxTtlSeconds?: number;
  gaslessStuckQueueThresholdMs?: number;
  gaslessReceiptTimeoutMs?: number;
  gaslessOutcomeReconciliationIntervalMs?: number;
  gaslessRepeatedFailureAlertThreshold?: number;
  gaslessRequireRpcFallback?: boolean;
  oracleBaseUrl?: string;
  oracleServiceApiKey?: string;
  oracleServiceApiSecret?: string;
  treasuryBaseUrl?: string;
  treasuryServiceApiKey?: string;
  treasuryServiceApiSecret?: string;
  reconciliationBaseUrl?: string;
  ricardianBaseUrl?: string;
  ricardianServiceApiKey?: string;
  ricardianServiceApiSecret?: string;
  notificationsBaseUrl?: string;
  downstreamReadRetryBudget?: number;
  downstreamMutationRetryBudget?: number;
  downstreamReadTimeoutMs?: number;
  downstreamMutationTimeoutMs?: number;
  corsAllowedOrigins: string[];
  corsAllowNoOrigin: boolean;
  rateLimitEnabled: boolean;
  rateLimitRedisUrl?: string;
  rateLimitFailOpen?: boolean;
  allowInsecureDownstreamAuth: boolean;
  commitSha: string;
  buildTime: string;
  nodeEnv: string;
}

export interface StepUpPolicy {
  maxAgeSeconds: number;
  acceptedStrengths: string[];
  enforcement: 'enforce' | 'record';
}

export const DEFAULT_STEP_UP_POLICY: StepUpPolicy = Object.freeze({
  maxAgeSeconds: 300,
  acceptedStrengths: ['hardware_webauthn'],
  enforcement: 'enforce',
});

export function resolveStepUpPolicy(config: GatewayConfig): StepUpPolicy {
  return {
    maxAgeSeconds: config.stepUpMaxAgeSeconds ?? DEFAULT_STEP_UP_POLICY.maxAgeSeconds,
    acceptedStrengths:
      config.stepUpAcceptedStrengths && config.stepUpAcceptedStrengths.length > 0
        ? [...config.stepUpAcceptedStrengths]
        : [...DEFAULT_STEP_UP_POLICY.acceptedStrengths],
    enforcement: config.stepUpEnforcement ?? DEFAULT_STEP_UP_POLICY.enforcement,
  };
}

export function resolveGovernancePreparationTtlSeconds(config: GatewayConfig): number {
  const ttlSeconds = config.governancePreparationTtlSeconds ?? config.governanceQueueTtlSeconds;
  if (ttlSeconds === undefined || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('A positive governance preparation TTL is required.');
  }
  return ttlSeconds;
}
