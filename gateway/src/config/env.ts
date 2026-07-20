/**
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { getAddress, isAddress } from 'ethers';
import { parseAllowedOrigins } from '@agroasys/shared-edge';
import { resolveSettlementRuntime, type SettlementRuntimeKey } from '@agroasys/sdk';
import { calculateGaslessExecutorCapacityPolicy } from '../core/gaslessExecutorCapacityPolicy';

dotenv.config();

export interface GatewayConfig {
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbMigrationUser?: string;
  dbMigrationPassword?: string;
  authBaseUrl: string;
  authRequestTimeoutMs: number;
  indexerGraphqlUrl: string;
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
  operatorSignerEnvironment?: string;
  enableMutations: boolean;
  writeAllowlist: string[];
  governanceQueueTtlSeconds: number;
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
  settlementCallbackRequestTimeoutMs: number;
  settlementCallbackPollIntervalMs: number;
  settlementCallbackMaxAttempts: number;
  settlementCallbackInitialBackoffMs: number;
  settlementCallbackMaxBackoffMs: number;
  gaslessExecutionEnabled?: boolean;
  gaslessExecutorPrivateKey?: string;
  gaslessSignerCustodyMode?: 'raw_private_key' | 'kms' | 'mpc';
  gaslessManagedSignerUrl?: string;
  gaslessManagedSignerApiKey?: string;
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

function env(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) {
    return fallback;
  }

  const value = raw ?? env(name);
  const parsed = Number.parseInt(value, 10);
  assert(!Number.isNaN(parsed), `${name} must be a number`);
  return parsed;
}

function envPositiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) {
    return fallback;
  }

  const value = raw ?? env(name);
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed > 0, `${name} must be a positive integer`);
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (raw.toLowerCase() === 'true') {
    return true;
  }

  if (raw.toLowerCase() === 'false') {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  assert(/^\d+$/.test(raw), `${name} must be a non-negative integer`);
  return BigInt(raw);
}

function parseGaslessSignerCustodyMode(
  value: string | undefined,
): 'raw_private_key' | 'kms' | 'mpc' {
  const normalized = value?.trim() || 'raw_private_key';
  if (normalized === 'raw_private_key' || normalized === 'kms' || normalized === 'mpc') {
    return normalized;
  }

  throw new Error('GATEWAY_GASLESS_SIGNER_CUSTODY_MODE must be raw_private_key, kms, or mpc');
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseUrlList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => value.replace(/\/$/, ''));
}

function assertAddress(name: string, value: string): string {
  assert(isAddress(value), `${name} must be a valid EVM address`);
  return getAddress(value);
}

function assertPrivateKey(name: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  assert(/^0x[a-fA-F0-9]{64}$/.test(value), `${name} must be a 32-byte hex private key`);
  return value;
}

function assertDownstreamServiceAuth(
  serviceName: string,
  baseUrl: string | undefined,
  apiKey: string | undefined,
  apiSecret: string | undefined,
  allowInsecureDownstreamAuth: boolean,
): void {
  if (!baseUrl || allowInsecureDownstreamAuth) {
    return;
  }

  assert(
    Boolean(apiKey && apiSecret),
    `${serviceName} requires a service API key and secret when GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH=false`,
  );
}

export function loadConfig(): GatewayConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const buildTime = process.env.GATEWAY_BUILD_TIME?.trim() || new Date().toISOString();
  const authBaseUrl = env('GATEWAY_AUTH_BASE_URL').replace(/\/$/, '');
  const indexerGraphqlUrl = env('GATEWAY_INDEXER_GRAPHQL_URL').replace(/\/$/, '');
  const escrowAddress = assertAddress('GATEWAY_ESCROW_ADDRESS', env('GATEWAY_ESCROW_ADDRESS'));
  const runtime = resolveSettlementRuntime({
    runtimeKey: optionalEnv('GATEWAY_SETTLEMENT_RUNTIME'),
    rpcUrl: optionalEnv('GATEWAY_RPC_URL'),
    rpcFallbackUrls: parseUrlList(process.env.GATEWAY_RPC_FALLBACK_URLS),
    chainId: process.env.GATEWAY_CHAIN_ID ? envNumber('GATEWAY_CHAIN_ID') : null,
    explorerBaseUrl: optionalEnv('GATEWAY_EXPLORER_BASE_URL'),
    escrowAddress,
    usdcAddress: optionalEnv('GATEWAY_USDC_ADDRESS'),
  });
  const rpcUrl = runtime.rpcUrl;
  const rpcFallbackUrls = runtime.rpcFallbackUrls;
  const chainId = runtime.chainId;
  const writeAllowlist = parseAllowlist(process.env.GATEWAY_WRITE_ALLOWLIST);
  const enableMutations = envBool('GATEWAY_ENABLE_MUTATIONS', false);
  const settlementIngressEnabled = envBool('GATEWAY_SETTLEMENT_INGRESS_ENABLED', false);
  const immediateInspectionAcceptanceEnabled = envBool(
    'GATEWAY_IMMEDIATE_INSPECTION_ACCEPTANCE_ENABLED',
    false,
  );
  const settlementServiceAuthApiKeysJson =
    process.env.GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON?.trim() || '[]';
  const settlementServiceAuthSharedSecret =
    process.env.GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET?.trim() || undefined;
  const settlementCallbackEnabled = envBool('GATEWAY_SETTLEMENT_CALLBACK_ENABLED', false);
  const settlementCallbackUrl =
    process.env.GATEWAY_SETTLEMENT_CALLBACK_URL?.trim()?.replace(/\/$/, '') || undefined;
  const settlementCallbackApiKey =
    process.env.GATEWAY_SETTLEMENT_CALLBACK_API_KEY?.trim() || undefined;
  const settlementCallbackApiSecret =
    process.env.GATEWAY_SETTLEMENT_CALLBACK_API_SECRET?.trim() || undefined;
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
  const gaslessCapacityPolicy = calculateGaslessExecutorCapacityPolicy({
    targetTransactionsPerDay: gaslessCapacityTargetTxPerDay,
    burstMultiplierBasisPoints: gaslessCapacityBurstMultiplierBasisPoints,
    safetyMarginBasisPoints: gaslessCapacitySafetyMarginBasisPoints,
    maxCostPerTxWei: gaslessMaxGasLimit * gaslessMaxFeePerGasWei,
    configuredMinExecutorBalanceWei: gaslessMinExecutorBalanceWei,
    configuredLowBalanceAlertWei: gaslessLowBalanceAlertWei,
    failClosed: gaslessCapacityFailClosed,
  });
  const gaslessCapacityRequiredExecutorBalanceWei = BigInt(
    gaslessCapacityPolicy.requiredBurstHourBalanceWei,
  );
  const oracleBaseUrl =
    process.env.GATEWAY_ORACLE_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
  const treasuryBaseUrl =
    process.env.GATEWAY_TREASURY_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
  const reconciliationBaseUrl =
    process.env.GATEWAY_RECONCILIATION_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
  const ricardianBaseUrl =
    process.env.GATEWAY_RICARDIAN_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
  const notificationsBaseUrl =
    process.env.GATEWAY_NOTIFICATIONS_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
  const oracleServiceApiKey = process.env.GATEWAY_ORACLE_SERVICE_API_KEY?.trim() || undefined;
  const oracleServiceApiSecret = process.env.GATEWAY_ORACLE_SERVICE_API_SECRET?.trim() || undefined;
  const treasuryServiceApiKey = process.env.GATEWAY_TREASURY_SERVICE_API_KEY?.trim() || undefined;
  const treasuryServiceApiSecret =
    process.env.GATEWAY_TREASURY_SERVICE_API_SECRET?.trim() || undefined;
  const ricardianServiceApiKey = process.env.GATEWAY_RICARDIAN_SERVICE_API_KEY?.trim() || undefined;
  const ricardianServiceApiSecret =
    process.env.GATEWAY_RICARDIAN_SERVICE_API_SECRET?.trim() || undefined;
  const dbMigrationUser = process.env.DB_MIGRATION_USER?.trim() || undefined;
  const dbMigrationPassword = process.env.DB_MIGRATION_PASSWORD?.trim() || undefined;
  const operatorSignerEnvironment =
    process.env.GATEWAY_OPERATOR_SIGNER_ENVIRONMENT?.trim() || nodeEnv;
  const allowInsecureDownstreamAuth = envBool(
    'GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH',
    nodeEnv !== 'production',
  );

  assert(
    authBaseUrl.startsWith('http://') || authBaseUrl.startsWith('https://'),
    'GATEWAY_AUTH_BASE_URL must be an absolute http(s) URL',
  );
  assert(
    indexerGraphqlUrl.startsWith('http://') || indexerGraphqlUrl.startsWith('https://'),
    'GATEWAY_INDEXER_GRAPHQL_URL must be an absolute http(s) URL',
  );
  assert(
    rpcUrl.startsWith('http://') || rpcUrl.startsWith('https://'),
    'GATEWAY_RPC_URL must be an absolute http(s) URL',
  );
  if (gaslessManagedSignerUrl) {
    assert(
      gaslessManagedSignerUrl.startsWith('http://') ||
        gaslessManagedSignerUrl.startsWith('https://'),
      'GATEWAY_GASLESS_MANAGED_SIGNER_URL must be an absolute http(s) URL',
    );
  }
  for (const [index, fallbackUrl] of rpcFallbackUrls.entries()) {
    assert(
      fallbackUrl.startsWith('http://') || fallbackUrl.startsWith('https://'),
      `GATEWAY_RPC_FALLBACK_URLS[${index}] must be an absolute http(s) URL`,
    );
  }
  for (const [name, value] of [
    ['GATEWAY_ORACLE_BASE_URL', oracleBaseUrl],
    ['GATEWAY_TREASURY_BASE_URL', treasuryBaseUrl],
    ['GATEWAY_RECONCILIATION_BASE_URL', reconciliationBaseUrl],
    ['GATEWAY_RICARDIAN_BASE_URL', ricardianBaseUrl],
    ['GATEWAY_NOTIFICATIONS_BASE_URL', notificationsBaseUrl],
  ] as const) {
    if (!value) {
      continue;
    }

    assert(
      value.startsWith('http://') || value.startsWith('https://'),
      `${name} must be an absolute http(s) URL`,
    );
  }
  assert(envNumber('PORT', 3600) > 0, 'PORT must be > 0');
  assert(envNumber('DB_PORT', 5432) > 0, 'DB_PORT must be > 0');
  assert(
    Boolean(dbMigrationUser) === Boolean(dbMigrationPassword),
    'DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together',
  );
  assert(chainId > 0, 'GATEWAY_CHAIN_ID must be > 0');
  assert(
    envNumber('GATEWAY_AUTH_REQUEST_TIMEOUT_MS', 5000) >= 1000,
    'GATEWAY_AUTH_REQUEST_TIMEOUT_MS must be >= 1000',
  );
  assert(
    envNumber('GATEWAY_INDEXER_REQUEST_TIMEOUT_MS', 5000) >= 1000,
    'GATEWAY_INDEXER_REQUEST_TIMEOUT_MS must be >= 1000',
  );
  assert(
    envNumber('GATEWAY_RPC_READ_TIMEOUT_MS', 8000) >= 1000,
    'GATEWAY_RPC_READ_TIMEOUT_MS must be >= 1000',
  );
  assert(
    !process.env.GATEWAY_RPC_QUORUM ||
      (envNumber('GATEWAY_RPC_QUORUM') >= 1 && envNumber('GATEWAY_RPC_QUORUM') <= 10),
    'GATEWAY_RPC_QUORUM must be between 1 and 10',
  );
  assert(
    envNumber('GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS', 86400) >= 60,
    'GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS must be >= 60',
  );
  assert(
    envNumber('GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS', 300) >= 30,
    'GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS must be >= 30',
  );
  assert(
    envNumber('GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS', 600) >= 60,
    'GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS must be >= 60',
  );
  assert(
    envNumber('GATEWAY_SETTLEMENT_CALLBACK_REQUEST_TIMEOUT_MS', 5000) >= 1000,
    'GATEWAY_SETTLEMENT_CALLBACK_REQUEST_TIMEOUT_MS must be >= 1000',
  );
  assert(
    envNumber('GATEWAY_SETTLEMENT_CALLBACK_POLL_INTERVAL_MS', 5000) >= 1000,
    'GATEWAY_SETTLEMENT_CALLBACK_POLL_INTERVAL_MS must be >= 1000',
  );
  assert(
    envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_ATTEMPTS', 8) >= 1,
    'GATEWAY_SETTLEMENT_CALLBACK_MAX_ATTEMPTS must be >= 1',
  );
  assert(
    envNumber('GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS', 2000) >= 250,
    'GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS must be >= 250',
  );
  assert(
    envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_BACKOFF_MS', 60000) >=
      envNumber('GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS', 2000),
    'GATEWAY_SETTLEMENT_CALLBACK_MAX_BACKOFF_MS must be >= GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS',
  );
  assert(
    envNumber('GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET', 1) >= 0,
    'GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET must be >= 0',
  );
  assert(
    envNumber('GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET', 0) >= 0,
    'GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET must be >= 0',
  );
  assert(
    envNumber('GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS', 5000) >= 1000,
    'GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS must be >= 1000',
  );
  assert(
    envNumber('GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS', 8000) >= 1000,
    'GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS must be >= 1000',
  );
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

  if (
    (oracleServiceApiKey && !oracleServiceApiSecret) ||
    (!oracleServiceApiKey && oracleServiceApiSecret)
  ) {
    throw new Error(
      'GATEWAY_ORACLE_SERVICE_API_KEY and GATEWAY_ORACLE_SERVICE_API_SECRET must be set together',
    );
  }

  if (
    (treasuryServiceApiKey && !treasuryServiceApiSecret) ||
    (!treasuryServiceApiKey && treasuryServiceApiSecret)
  ) {
    throw new Error(
      'GATEWAY_TREASURY_SERVICE_API_KEY and GATEWAY_TREASURY_SERVICE_API_SECRET must be set together',
    );
  }

  if (
    (ricardianServiceApiKey && !ricardianServiceApiSecret) ||
    (!ricardianServiceApiKey && ricardianServiceApiSecret)
  ) {
    throw new Error(
      'GATEWAY_RICARDIAN_SERVICE_API_KEY and GATEWAY_RICARDIAN_SERVICE_API_SECRET must be set together',
    );
  }

  assertDownstreamServiceAuth(
    'GATEWAY_ORACLE_BASE_URL',
    oracleBaseUrl,
    oracleServiceApiKey,
    oracleServiceApiSecret,
    allowInsecureDownstreamAuth,
  );
  assertDownstreamServiceAuth(
    'GATEWAY_TREASURY_BASE_URL',
    treasuryBaseUrl,
    treasuryServiceApiKey,
    treasuryServiceApiSecret,
    allowInsecureDownstreamAuth,
  );
  assertDownstreamServiceAuth(
    'GATEWAY_RICARDIAN_BASE_URL',
    ricardianBaseUrl,
    ricardianServiceApiKey,
    ricardianServiceApiSecret,
    allowInsecureDownstreamAuth,
  );

  if (settlementIngressEnabled) {
    assert(
      settlementServiceAuthApiKeysJson !== '[]' || settlementServiceAuthSharedSecret,
      'GATEWAY_SETTLEMENT_INGRESS_ENABLED requires GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON or GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET',
    );
  }

  assert(
    !immediateInspectionAcceptanceEnabled || (nodeEnv !== 'production' && chainId !== 8453),
    'GATEWAY_IMMEDIATE_INSPECTION_ACCEPTANCE_ENABLED cannot be enabled in production until buyer-signed on-chain acceptance is implemented',
  );

  if (settlementCallbackEnabled) {
    assert(
      settlementCallbackUrl,
      'GATEWAY_SETTLEMENT_CALLBACK_URL is required when GATEWAY_SETTLEMENT_CALLBACK_ENABLED=true',
    );
    assert(
      settlementCallbackUrl.startsWith('http://') || settlementCallbackUrl.startsWith('https://'),
      'GATEWAY_SETTLEMENT_CALLBACK_URL must be an absolute http(s) URL',
    );
    assert(
      settlementCallbackApiKey,
      'GATEWAY_SETTLEMENT_CALLBACK_API_KEY is required when GATEWAY_SETTLEMENT_CALLBACK_ENABLED=true',
    );
    assert(
      settlementCallbackApiSecret,
      'GATEWAY_SETTLEMENT_CALLBACK_API_SECRET is required when GATEWAY_SETTLEMENT_CALLBACK_ENABLED=true',
    );
  }

  if (gaslessExecutionEnabled) {
    if (gaslessSignerCustodyMode === 'raw_private_key') {
      assert(
        gaslessExecutorPrivateKey,
        'GATEWAY_GASLESS_EXECUTION_ENABLED requires GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY or GATEWAY_EXECUTOR_PRIVATE_KEY when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE=raw_private_key',
      );
    } else {
      assert(
        gaslessManagedSignerUrl,
        'GATEWAY_GASLESS_EXECUTION_ENABLED requires GATEWAY_GASLESS_MANAGED_SIGNER_URL when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE is kms or mpc',
      );
      assert(
        !gaslessExecutorPrivateKey,
        'GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY must not be set when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE is kms or mpc',
      );
    }
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
        gaslessCapacityPolicy.floorMeetsPolicy,
        'GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI must cover the configured gasless burst-hour capacity policy when fail-closed capacity is enabled',
      );
      assert(
        gaslessCapacityPolicy.lowBalanceAlertProtectsPolicy,
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
      assert(
        gaslessManagedSignerUrl?.startsWith('https://'),
        'Production managed gasless signer custody requires an https GATEWAY_GASLESS_MANAGED_SIGNER_URL',
      );
      assert(
        Boolean(gaslessManagedSignerApiKey),
        'Production managed gasless signer custody requires GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY',
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
    port: envNumber('PORT', 3600),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT', 5432),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    dbMigrationUser,
    dbMigrationPassword,
    authBaseUrl,
    authRequestTimeoutMs: envNumber('GATEWAY_AUTH_REQUEST_TIMEOUT_MS', 5000),
    indexerGraphqlUrl,
    indexerRequestTimeoutMs: envNumber('GATEWAY_INDEXER_REQUEST_TIMEOUT_MS', 5000),
    rpcUrl,
    rpcFallbackUrls,
    rpcReadTimeoutMs: envNumber('GATEWAY_RPC_READ_TIMEOUT_MS', 8000),
    rpcQuorum: process.env.GATEWAY_RPC_QUORUM ? envNumber('GATEWAY_RPC_QUORUM') : undefined,
    chainId,
    escrowAddress: assertAddress('GATEWAY_ESCROW_ADDRESS', runtime.escrowAddress ?? escrowAddress),
    usdcAddress: assertAddress(
      'GATEWAY_USDC_ADDRESS',
      runtime.usdcAddress ?? env('GATEWAY_USDC_ADDRESS'),
    ),
    settlementRuntimeKey: runtime.runtimeKey,
    networkName: runtime.networkName,
    explorerBaseUrl: runtime.explorerBaseUrl,
    operatorSignerEnvironment,
    enableMutations,
    writeAllowlist,
    governanceQueueTtlSeconds: envNumber('GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS', 86400),
    settlementIngressEnabled,
    immediateInspectionAcceptanceEnabled,
    settlementServiceAuthApiKeysJson,
    settlementServiceAuthSharedSecret,
    settlementServiceAuthMaxSkewSeconds: envNumber(
      'GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS',
      300,
    ),
    settlementServiceAuthNonceTtlSeconds: envNumber(
      'GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS',
      600,
    ),
    settlementCallbackEnabled,
    settlementCallbackUrl,
    settlementCallbackApiKey,
    settlementCallbackApiSecret,
    settlementCallbackRequestTimeoutMs: envNumber(
      'GATEWAY_SETTLEMENT_CALLBACK_REQUEST_TIMEOUT_MS',
      5000,
    ),
    settlementCallbackPollIntervalMs: envNumber(
      'GATEWAY_SETTLEMENT_CALLBACK_POLL_INTERVAL_MS',
      5000,
    ),
    settlementCallbackMaxAttempts: envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_ATTEMPTS', 8),
    settlementCallbackInitialBackoffMs: envNumber(
      'GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS',
      2000,
    ),
    settlementCallbackMaxBackoffMs: envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_BACKOFF_MS', 60000),
    gaslessExecutionEnabled,
    gaslessExecutorPrivateKey,
    gaslessSignerCustodyMode,
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
    gaslessCapacityRequiredExecutorBalanceWei,
    gaslessCapacityFailClosed,
    gaslessRequestMaxTtlSeconds: envNumber('GATEWAY_GASLESS_REQUEST_MAX_TTL_SECONDS', 900),
    gaslessStuckQueueThresholdMs: envNumber('GATEWAY_GASLESS_STUCK_QUEUE_THRESHOLD_MS', 300000),
    gaslessReceiptTimeoutMs: envNumber('GATEWAY_GASLESS_RECEIPT_TIMEOUT_MS', 120000),
    gaslessRepeatedFailureAlertThreshold: envNumber(
      'GATEWAY_GASLESS_REPEATED_FAILURE_ALERT_THRESHOLD',
      3,
    ),
    gaslessRequireRpcFallback,
    oracleBaseUrl,
    oracleServiceApiKey,
    oracleServiceApiSecret,
    treasuryBaseUrl,
    treasuryServiceApiKey,
    treasuryServiceApiSecret,
    reconciliationBaseUrl,
    ricardianBaseUrl,
    ricardianServiceApiKey,
    ricardianServiceApiSecret,
    notificationsBaseUrl,
    downstreamReadRetryBudget: envNumber('GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET', 1),
    downstreamMutationRetryBudget: envNumber('GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET', 0),
    downstreamReadTimeoutMs: envNumber('GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS', 5000),
    downstreamMutationTimeoutMs: envNumber('GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS', 8000),
    corsAllowedOrigins: parseAllowedOrigins(process.env.GATEWAY_CORS_ALLOWED_ORIGINS),
    corsAllowNoOrigin: envBool('GATEWAY_CORS_ALLOW_NO_ORIGIN', false),
    rateLimitEnabled: envBool('GATEWAY_RATE_LIMIT_ENABLED', true),
    rateLimitRedisUrl: process.env.GATEWAY_RATE_LIMIT_REDIS_URL?.trim() || undefined,
    rateLimitFailOpen: envBool('GATEWAY_RATE_LIMIT_FAIL_OPEN', false),
    allowInsecureDownstreamAuth,
    commitSha: process.env.GATEWAY_COMMIT_SHA?.trim() || 'local-dev',
    buildTime,
    nodeEnv,
  };
}
