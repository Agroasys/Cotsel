import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { parseAllowedOrigins } from '@agroasys/shared-edge';
import { parsePostgresSslMode, type PostgresSslMode } from '@agroasys/shared-db';
import { resolveSettlementRuntime, type SettlementRuntimeKey } from '@agroasys/sdk';
import { parseServiceApiKeys, ServiceApiKey } from './auth/serviceAuth';
import {
  parseProviderWebhookSecrets,
  type ProviderWebhookSecret,
} from './core/providerCallbackAuth';

dotenv.config();

export type NonceStoreMode = 'redis' | 'postgres' | 'inmemory';

export interface TreasuryConfig {
  nodeEnv: string;
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbSslMode: PostgresSslMode;
  indexerGraphqlUrl: string;
  indexerGraphqlRequestTimeoutMs: number;
  ingestBatchSize: number;
  ingestMaxEvents: number;
  authEnabled: boolean;
  apiKeys: ServiceApiKey[];
  internalMutationApiKeys: string[];
  operatorDelegationApiKeys: string[];
  hmacSecret?: string;
  authMaxSkewSeconds: number;
  authNonceTtlSeconds: number;
  providerCallbackAuthEnabled: boolean;
  providerWebhookSecrets: ProviderWebhookSecret[];
  providerCallbackMaxSkewSeconds: number;
  nonceStore: NonceStoreMode;
  nonceRedisUrl?: string;
  nonceTtlSeconds: number;
  corsAllowedOrigins: string[];
  corsAllowNoOrigin: boolean;
  rateLimitEnabled: boolean;
  rateLimitRedisUrl?: string;
  settlementRuntimeKey?: SettlementRuntimeKey;
  rpcUrl?: string;
  rpcFallbackUrls: string[];
  rpcQuorum?: number;
  rpcStallTimeoutMs?: number;
  chainId?: number;
  explorerBaseUrl?: string | null;
  reconciliationDb: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    sslMode: PostgresSslMode;
  } | null;
  reconciliationMaxAgeSeconds: number;
  reconciliationMaxRunningRunAgeSeconds: number;
}

function env(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
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

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envUrl(name: string): string {
  const value = env(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL, received "${value}"`);
  }

  assert(
    parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'ws:' ||
      parsed.protocol === 'wss:',
    `${name} must use http, https, ws, or wss protocol`,
  );

  return value.replace(/\/$/, '');
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

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function hasSettlementRuntimeOverride(): boolean {
  return Boolean(
    optionalEnv('SETTLEMENT_RUNTIME') || optionalEnv('RPC_URL') || optionalEnv('CHAIN_ID'),
  );
}

function resolveNonceStoreMode(nodeEnv: string): NonceStoreMode {
  const rawMode = process.env.NONCE_STORE?.trim().toLowerCase();

  if (!rawMode) {
    if (nodeEnv === 'production') {
      return process.env.REDIS_URL?.trim() ? 'redis' : 'postgres';
    }

    return 'inmemory';
  }

  if (rawMode === 'redis' || rawMode === 'postgres' || rawMode === 'inmemory') {
    return rawMode;
  }

  throw new Error('NONCE_STORE must be one of: redis, postgres, inmemory');
}

export function loadConfig(): TreasuryConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const authEnabled = envBool('AUTH_ENABLED', nodeEnv === 'production');
  const apiKeys = parseServiceApiKeys(process.env.API_KEYS_JSON);
  const configuredMutationApiKeys = parseAllowlist(process.env.TREASURY_INTERNAL_MUTATION_API_KEYS);
  const inferredMutationApiKeys =
    configuredMutationApiKeys.length > 0
      ? configuredMutationApiKeys
      : apiKeys.filter((key) => /gateway/i.test(key.id)).map((key) => key.id);
  const internalMutationApiKeys =
    inferredMutationApiKeys.length > 0
      ? inferredMutationApiKeys
      : apiKeys.length === 1
        ? [apiKeys[0].id]
        : [];
  // Operator traffic reaches treasury through the dashboard gateway, which
  // authenticates the human and then calls under its own service key. Naming a
  // caller here lets it assert the operator identity it authenticated, which is
  // a separation-of-duty exception and therefore never inferred: the list is
  // empty unless a deployment states it, so an unlisted internal caller cannot
  // manufacture distinct maker and checker identities.
  const operatorDelegationApiKeys = parseAllowlist(
    process.env.TREASURY_OPERATOR_DELEGATION_API_KEYS,
  );
  const hmacSecret = process.env.HMAC_SECRET?.trim();
  const providerWebhookSecrets = parseProviderWebhookSecrets(
    process.env.TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON,
  );
  const providerCallbackAuthEnabled = envBool(
    'TREASURY_PROVIDER_CALLBACK_AUTH_ENABLED',
    authEnabled,
  );
  const nonceStore = resolveNonceStoreMode(nodeEnv);
  const nonceRedisUrl = process.env.REDIS_URL?.trim() || undefined;
  const rateLimitEnabled = envBool('RATE_LIMIT_ENABLED', true);
  const rateLimitRedisUrl = process.env.RATE_LIMIT_REDIS_URL?.trim() || undefined;
  const authNonceTtlSeconds = envNumber('AUTH_NONCE_TTL_SECONDS', 600);
  const nonceTtlSeconds = process.env.NONCE_TTL_SECONDS
    ? envNumber('NONCE_TTL_SECONDS')
    : authNonceTtlSeconds;
  const indexerGraphqlRequestTimeoutMs = envNumber('INDEXER_GQL_TIMEOUT_MS', 10000);
  const runtime = hasSettlementRuntimeOverride()
    ? resolveSettlementRuntime({
        runtimeKey: optionalEnv('SETTLEMENT_RUNTIME'),
        rpcUrl: optionalEnv('RPC_URL') ? envUrl('RPC_URL') : undefined,
        rpcFallbackUrls: parseUrlList(process.env.RPC_FALLBACK_URLS),
        chainId: optionalEnv('CHAIN_ID') ? envNumber('CHAIN_ID') : null,
        explorerBaseUrl: optionalEnv('EXPLORER_BASE_URL'),
      })
    : null;
  const reconciliationDbName = optionalEnv('RECONCILIATION_DB_NAME');
  if (authEnabled) {
    assert(
      apiKeys.length > 0 || Boolean(hmacSecret),
      'AUTH_ENABLED=true requires either API_KEYS_JSON entries or HMAC_SECRET',
    );
    assert(
      internalMutationApiKeys.length > 0,
      'AUTH_ENABLED=true requires TREASURY_INTERNAL_MUTATION_API_KEYS or a gateway-designated API key',
    );
  }

  if (nodeEnv === 'production' && !authEnabled) {
    throw new Error('AUTH_ENABLED=false is not allowed when NODE_ENV=production');
  }

  // A delegating caller must be an identity treasury can actually authenticate
  // and one already trusted to mutate treasury state. Anything else would grant
  // the exception to a key that cannot use it, or widen mutation access.
  for (const apiKeyId of operatorDelegationApiKeys) {
    assert(
      apiKeys.some((key) => key.id === apiKeyId),
      `TREASURY_OPERATOR_DELEGATION_API_KEYS names ${apiKeyId}, which is not a configured API key`,
    );
    assert(
      internalMutationApiKeys.includes(apiKeyId),
      `TREASURY_OPERATOR_DELEGATION_API_KEYS names ${apiKeyId}, which is not an internal mutation caller`,
    );
  }

  // External completion evidence is only worth what its provenance proves, so a
  // production deployment may not accept provider callbacks it cannot verify.
  if (nodeEnv === 'production' && !providerCallbackAuthEnabled) {
    throw new Error(
      'TREASURY_PROVIDER_CALLBACK_AUTH_ENABLED=false is not allowed when NODE_ENV=production',
    );
  }

  if (nodeEnv === 'production' && nonceStore === 'inmemory') {
    throw new Error('NONCE_STORE=inmemory is not allowed when NODE_ENV=production');
  }

  if (nonceStore === 'redis') {
    assert(nonceRedisUrl, 'REDIS_URL is required when NONCE_STORE=redis');
  }

  // Treasury's operator path runs through a delegating gateway. In production,
  // an empty list is not a safe default but a silent outage: every
  // operator-initiated transition would be refused as an actor mismatch. Fail
  // at startup instead of at the first approval.
  if (nodeEnv === 'production' && authEnabled) {
    assert(
      operatorDelegationApiKeys.length > 0,
      'NODE_ENV=production requires TREASURY_OPERATOR_DELEGATION_API_KEYS to name the delegating gateway API key',
    );
  }

  assert(
    indexerGraphqlRequestTimeoutMs >= 1000 && indexerGraphqlRequestTimeoutMs <= 60000,
    'INDEXER_GQL_TIMEOUT_MS must be between 1000 and 60000',
  );

  const config: TreasuryConfig = {
    nodeEnv,
    port: envNumber('PORT'),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT'),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    dbSslMode: parsePostgresSslMode(process.env.DB_SSL_MODE),
    indexerGraphqlUrl: env('INDEXER_GRAPHQL_URL'),
    indexerGraphqlRequestTimeoutMs,
    ingestBatchSize: envNumber('TREASURY_INGEST_BATCH_SIZE', 100),
    ingestMaxEvents: envNumber('TREASURY_INGEST_MAX_EVENTS', 2000),
    authEnabled,
    apiKeys,
    internalMutationApiKeys,
    operatorDelegationApiKeys,
    hmacSecret,
    authMaxSkewSeconds: envNumber('AUTH_MAX_SKEW_SECONDS', 300),
    authNonceTtlSeconds,
    providerCallbackAuthEnabled,
    providerWebhookSecrets,
    providerCallbackMaxSkewSeconds: envNumber(
      'TREASURY_PROVIDER_CALLBACK_MAX_SKEW_SECONDS',
      envNumber('AUTH_MAX_SKEW_SECONDS', 300),
    ),
    nonceStore,
    nonceRedisUrl,
    nonceTtlSeconds,
    corsAllowedOrigins: parseAllowedOrigins(process.env.TREASURY_CORS_ALLOWED_ORIGINS),
    corsAllowNoOrigin: envBool('TREASURY_CORS_ALLOW_NO_ORIGIN', false),
    rateLimitEnabled,
    rateLimitRedisUrl,
    settlementRuntimeKey: runtime?.runtimeKey,
    rpcUrl: runtime?.rpcUrl,
    rpcFallbackUrls: runtime?.rpcFallbackUrls ?? [],
    rpcQuorum: optionalEnv('RPC_QUORUM') ? envNumber('RPC_QUORUM') : undefined,
    rpcStallTimeoutMs: optionalEnv('RPC_STALL_TIMEOUT_MS')
      ? envNumber('RPC_STALL_TIMEOUT_MS')
      : undefined,
    chainId: runtime?.chainId,
    explorerBaseUrl: runtime?.explorerBaseUrl ?? null,
    reconciliationDb: reconciliationDbName
      ? {
          host: optionalEnv('RECONCILIATION_DB_HOST') || env('DB_HOST'),
          port: envNumber('RECONCILIATION_DB_PORT', envNumber('DB_PORT')),
          name: reconciliationDbName,
          user: optionalEnv('RECONCILIATION_DB_USER') || env('DB_USER'),
          password: optionalEnv('RECONCILIATION_DB_PASSWORD') || env('DB_PASSWORD'),
          sslMode: parsePostgresSslMode(
            process.env.RECONCILIATION_DB_SSL_MODE,
            parsePostgresSslMode(process.env.DB_SSL_MODE),
          ),
        }
      : null,
    reconciliationMaxAgeSeconds: envNumber('RECONCILIATION_MAX_AGE_SECONDS', 900),
    reconciliationMaxRunningRunAgeSeconds: envNumber(
      'RECONCILIATION_MAX_RUNNING_RUN_AGE_SECONDS',
      900,
    ),
  };

  assert(config.ingestBatchSize > 0, 'TREASURY_INGEST_BATCH_SIZE must be > 0');
  assert(config.ingestMaxEvents > 0, 'TREASURY_INGEST_MAX_EVENTS must be > 0');
  assert(config.authMaxSkewSeconds > 0, 'AUTH_MAX_SKEW_SECONDS must be > 0');
  assert(
    config.providerCallbackMaxSkewSeconds > 0,
    'TREASURY_PROVIDER_CALLBACK_MAX_SKEW_SECONDS must be > 0',
  );
  assert(config.authNonceTtlSeconds > 0, 'AUTH_NONCE_TTL_SECONDS must be > 0');
  assert(config.nonceTtlSeconds > 0, 'NONCE_TTL_SECONDS must be > 0');
  assert(config.reconciliationMaxAgeSeconds > 0, 'RECONCILIATION_MAX_AGE_SECONDS must be > 0');
  assert(
    config.reconciliationMaxRunningRunAgeSeconds > 0,
    'RECONCILIATION_MAX_RUNNING_RUN_AGE_SECONDS must be > 0',
  );

  return config;
}

export const config = loadConfig();
