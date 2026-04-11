import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { parseAllowedOrigins } from '@agroasys/shared-edge';
import { parseServiceApiKeys, ServiceApiKey } from './auth/serviceAuth';

dotenv.config();

export type NonceStoreMode = 'redis' | 'postgres' | 'inmemory';

export interface RicardianConfig {
  nodeEnv: string;
  port: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbMigrationUser?: string;
  dbMigrationPassword?: string;
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
  rateLimitWriteBurstLimit: number;
  rateLimitWriteBurstWindowSeconds: number;
  rateLimitWriteSustainedLimit: number;
  rateLimitWriteSustainedWindowSeconds: number;
  rateLimitReadBurstLimit: number;
  rateLimitReadBurstWindowSeconds: number;
  rateLimitReadSustainedLimit: number;
  rateLimitReadSustainedWindowSeconds: number;
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

export function loadConfig(): RicardianConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const authEnabled = envBool('AUTH_ENABLED', nodeEnv === 'production');
  const apiKeys = parseServiceApiKeys(process.env.API_KEYS_JSON);
  const hmacSecret = process.env.HMAC_SECRET?.trim();
  const nonceStore = resolveNonceStoreMode(nodeEnv);
  const nonceRedisUrl = process.env.REDIS_URL?.trim() || undefined;
  const dbMigrationUser = process.env.DB_MIGRATION_USER?.trim() || undefined;
  const dbMigrationPassword = process.env.DB_MIGRATION_PASSWORD?.trim() || undefined;
  const authNonceTtlSeconds = envNumber('AUTH_NONCE_TTL_SECONDS', 600);
  const nonceTtlSeconds = process.env.NONCE_TTL_SECONDS
    ? envNumber('NONCE_TTL_SECONDS')
    : authNonceTtlSeconds;

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
  assert(
    Boolean(dbMigrationUser) === Boolean(dbMigrationPassword),
    'DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together',
  );

  const rateLimitEnabled = envBool('RATE_LIMIT_ENABLED', true);

  const config: RicardianConfig = {
    nodeEnv,
    port: envNumber('PORT'),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT'),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    dbMigrationUser,
    dbMigrationPassword,
    authEnabled,
    apiKeys,
    hmacSecret,
    authMaxSkewSeconds: envNumber('AUTH_MAX_SKEW_SECONDS', 300),
    authNonceTtlSeconds,
    nonceStore,
    nonceRedisUrl,
    nonceTtlSeconds,
    corsAllowedOrigins: parseAllowedOrigins(process.env.RICARDIAN_CORS_ALLOWED_ORIGINS),
    corsAllowNoOrigin: envBool('RICARDIAN_CORS_ALLOW_NO_ORIGIN', false),
    rateLimitEnabled,
    rateLimitRedisUrl: process.env.RATE_LIMIT_REDIS_URL,
    rateLimitWriteBurstLimit: envNumber('RATE_LIMIT_WRITE_BURST_LIMIT', 10),
    rateLimitWriteBurstWindowSeconds: envNumber('RATE_LIMIT_WRITE_BURST_WINDOW_SECONDS', 10),
    rateLimitWriteSustainedLimit: envNumber('RATE_LIMIT_WRITE_SUSTAINED_LIMIT', 120),
    rateLimitWriteSustainedWindowSeconds: envNumber(
      'RATE_LIMIT_WRITE_SUSTAINED_WINDOW_SECONDS',
      60,
    ),
    rateLimitReadBurstLimit: envNumber('RATE_LIMIT_READ_BURST_LIMIT', 30),
    rateLimitReadBurstWindowSeconds: envNumber('RATE_LIMIT_READ_BURST_WINDOW_SECONDS', 10),
    rateLimitReadSustainedLimit: envNumber('RATE_LIMIT_READ_SUSTAINED_LIMIT', 600),
    rateLimitReadSustainedWindowSeconds: envNumber('RATE_LIMIT_READ_SUSTAINED_WINDOW_SECONDS', 60),
  };

  assert(config.authMaxSkewSeconds > 0, 'AUTH_MAX_SKEW_SECONDS must be > 0');
  assert(config.authNonceTtlSeconds > 0, 'AUTH_NONCE_TTL_SECONDS must be > 0');
  assert(config.nonceTtlSeconds > 0, 'NONCE_TTL_SECONDS must be > 0');
  assert(config.rateLimitWriteBurstLimit > 0, 'RATE_LIMIT_WRITE_BURST_LIMIT must be > 0');
  assert(
    config.rateLimitWriteBurstWindowSeconds > 0,
    'RATE_LIMIT_WRITE_BURST_WINDOW_SECONDS must be > 0',
  );
  assert(config.rateLimitWriteSustainedLimit > 0, 'RATE_LIMIT_WRITE_SUSTAINED_LIMIT must be > 0');
  assert(
    config.rateLimitWriteSustainedWindowSeconds > 0,
    'RATE_LIMIT_WRITE_SUSTAINED_WINDOW_SECONDS must be > 0',
  );
  assert(config.rateLimitReadBurstLimit > 0, 'RATE_LIMIT_READ_BURST_LIMIT must be > 0');
  assert(
    config.rateLimitReadBurstWindowSeconds > 0,
    'RATE_LIMIT_READ_BURST_WINDOW_SECONDS must be > 0',
  );
  assert(config.rateLimitReadSustainedLimit > 0, 'RATE_LIMIT_READ_SUSTAINED_LIMIT must be > 0');
  assert(
    config.rateLimitReadSustainedWindowSeconds > 0,
    'RATE_LIMIT_READ_SUSTAINED_WINDOW_SECONDS must be > 0',
  );

  return config;
}

export const config = loadConfig();
