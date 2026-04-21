/**
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { getAddress, isAddress } from 'ethers';
import { parseAllowedOrigins } from '@agroasys/shared-edge';
import { resolveSettlementRuntime, type SettlementRuntimeKey } from '@agroasys/sdk';

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
  chainId: number;
  escrowAddress: string;
  settlementRuntimeKey?: SettlementRuntimeKey;
  networkName?: string;
  explorerBaseUrl?: string | null;
  operatorSignerEnvironment?: string;
  enableMutations: boolean;
  writeAllowlist: string[];
  governanceQueueTtlSeconds: number;
  settlementIngressEnabled: boolean;
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
  const nodeEnv = process.env.NODE_ENV || 'development';
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
    chainId,
    escrowAddress: assertAddress('GATEWAY_ESCROW_ADDRESS', runtime.escrowAddress ?? escrowAddress),
    settlementRuntimeKey: runtime.runtimeKey,
    networkName: runtime.networkName,
    explorerBaseUrl: runtime.explorerBaseUrl,
    operatorSignerEnvironment,
    enableMutations,
    writeAllowlist,
    governanceQueueTtlSeconds: envNumber('GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS', 86400),
    settlementIngressEnabled,
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
