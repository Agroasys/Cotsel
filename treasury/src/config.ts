import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { parseAllowedOrigins } from '@agroasys/shared-edge';
import { resolveSettlementRuntime, type SettlementRuntimeKey } from '@agroasys/sdk';
import { parseServiceApiKeys, ServiceApiKey } from './auth/serviceAuth';

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
  dbMigrationUser?: string;
  dbMigrationPassword?: string;
  indexerGraphqlUrl: string;
  indexerGraphqlRequestTimeoutMs: number;
  ingestBatchSize: number;
  ingestMaxEvents: number;
  authEnabled: boolean;
  apiKeys: ServiceApiKey[];
  hmacSecret?: string;
  authMaxSkewSeconds: number;
  authNonceTtlSeconds: number;
  nonceStore: NonceStoreMode;
  nonceRedisUrl?: string;
  nonceTtlSeconds: number;
  corsAllowedOrigins: string[];
  corsAllowNoOrigin: boolean;
  rateLimitEnabled: boolean;
  rateLimitRedisUrl?: string;
  settlementRuntimeKey?: SettlementRuntimeKey;
  networkName?: string;
  rpcUrl?: string;
  rpcFallbackUrls: string[];
  chainId?: number;
  explorerBaseUrl?: string | null;
  reconciliationDb: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  } | null;
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
  const hmacSecret = process.env.HMAC_SECRET?.trim();
  const nonceStore = resolveNonceStoreMode(nodeEnv);
  const nonceRedisUrl = process.env.REDIS_URL?.trim() || undefined;
  const rateLimitEnabled = envBool('RATE_LIMIT_ENABLED', true);
  const rateLimitRedisUrl = process.env.RATE_LIMIT_REDIS_URL?.trim() || undefined;
  const authNonceTtlSeconds = envNumber('AUTH_NONCE_TTL_SECONDS', 600);
  const nonceTtlSeconds = process.env.NONCE_TTL_SECONDS
    ? envNumber('NONCE_TTL_SECONDS')
    : authNonceTtlSeconds;
  const indexerGraphqlTimeoutMinMs = envNumber('INDEXER_GQL_TIMEOUT_MIN_MS', 1000);
  const indexerGraphqlTimeoutMaxMs = envNumber('INDEXER_GQL_TIMEOUT_MAX_MS', 60000);
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
  const dbMigrationUser = optionalEnv('DB_MIGRATION_USER');
  const dbMigrationPassword = optionalEnv('DB_MIGRATION_PASSWORD');
  assert(
    Boolean(dbMigrationUser) === Boolean(dbMigrationPassword),
    'DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together',
  );

  if (authEnabled) {
    assert(
      apiKeys.length > 0 || Boolean(hmacSecret),
      'AUTH_ENABLED=true requires either API_KEYS_JSON entries or HMAC_SECRET',
    );
  }

  if (nodeEnv === 'production' && nonceStore === 'inmemory') {
    throw new Error('NONCE_STORE=inmemory is not allowed when NODE_ENV=production');
  }

  if (nonceStore === 'redis') {
    assert(nonceRedisUrl, 'REDIS_URL is required when NONCE_STORE=redis');
  }

  assert(indexerGraphqlTimeoutMinMs >= 1000, 'INDEXER_GQL_TIMEOUT_MIN_MS must be >= 1000');
  assert(indexerGraphqlTimeoutMaxMs <= 60000, 'INDEXER_GQL_TIMEOUT_MAX_MS must be <= 60000');
  assert(
    indexerGraphqlTimeoutMinMs <= indexerGraphqlTimeoutMaxMs,
    'INDEXER_GQL_TIMEOUT_MIN_MS must be <= INDEXER_GQL_TIMEOUT_MAX_MS',
  );
  assert(
    indexerGraphqlRequestTimeoutMs >= indexerGraphqlTimeoutMinMs &&
      indexerGraphqlRequestTimeoutMs <= indexerGraphqlTimeoutMaxMs,
    `INDEXER_GQL_TIMEOUT_MS must be between ${indexerGraphqlTimeoutMinMs} and ${indexerGraphqlTimeoutMaxMs}`,
  );

  const config: TreasuryConfig = {
    nodeEnv,
    port: envNumber('PORT'),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT'),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    dbMigrationUser,
    dbMigrationPassword,
    indexerGraphqlUrl: env('INDEXER_GRAPHQL_URL'),
    indexerGraphqlRequestTimeoutMs,
    ingestBatchSize: envNumber('TREASURY_INGEST_BATCH_SIZE', 100),
    ingestMaxEvents: envNumber('TREASURY_INGEST_MAX_EVENTS', 2000),
    authEnabled,
    apiKeys,
    hmacSecret,
    authMaxSkewSeconds: envNumber('AUTH_MAX_SKEW_SECONDS', 300),
    authNonceTtlSeconds,
    nonceStore,
    nonceRedisUrl,
    nonceTtlSeconds,
    corsAllowedOrigins: parseAllowedOrigins(process.env.TREASURY_CORS_ALLOWED_ORIGINS),
    corsAllowNoOrigin: envBool('TREASURY_CORS_ALLOW_NO_ORIGIN', false),
    rateLimitEnabled,
    rateLimitRedisUrl,
    settlementRuntimeKey: runtime?.runtimeKey,
    networkName: runtime?.networkName,
    rpcUrl: runtime?.rpcUrl,
    rpcFallbackUrls: runtime?.rpcFallbackUrls ?? [],
    chainId: runtime?.chainId,
    explorerBaseUrl: runtime?.explorerBaseUrl ?? null,
    reconciliationDb: reconciliationDbName
      ? {
          host: optionalEnv('RECONCILIATION_DB_HOST') || env('DB_HOST'),
          port: envNumber('RECONCILIATION_DB_PORT', envNumber('DB_PORT')),
          name: reconciliationDbName,
          user: optionalEnv('RECONCILIATION_DB_USER') || env('DB_USER'),
          password: optionalEnv('RECONCILIATION_DB_PASSWORD') || env('DB_PASSWORD'),
        }
      : null,
  };

  assert(config.ingestBatchSize > 0, 'TREASURY_INGEST_BATCH_SIZE must be > 0');
  assert(config.ingestMaxEvents > 0, 'TREASURY_INGEST_MAX_EVENTS must be > 0');
  assert(config.authMaxSkewSeconds > 0, 'AUTH_MAX_SKEW_SECONDS must be > 0');
  assert(config.authNonceTtlSeconds > 0, 'AUTH_NONCE_TTL_SECONDS must be > 0');
  assert(config.nonceTtlSeconds > 0, 'NONCE_TTL_SECONDS must be > 0');

  return config;
}

export const config = loadConfig();
