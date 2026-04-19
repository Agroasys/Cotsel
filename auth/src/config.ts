/**
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { parseAllowedOrigins } from '@agroasys/shared-edge';
import { AuthConfig } from './types';

dotenv.config();

function env(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

function envNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) {
    return fallback;
  }
  const required = raw ?? env(name);
  const num = parseInt(required, 10);
  assert(!isNaN(num), `${name} must be a number`);
  return num;
}

function envBoolean(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  assert(
    ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(normalized),
    `${name} must be a boolean`,
  );

  return ['true', '1', 'yes', 'on'].includes(normalized);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(): AuthConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const legacyWalletLoginEnabled = envBoolean('LEGACY_WALLET_LOGIN_ENABLED', false);
  const trustedSessionExchangeEnabled = envBoolean('TRUSTED_SESSION_EXCHANGE_ENABLED', false);
  const trustedSessionExchangeMaxSkewSeconds = envNumber(
    'TRUSTED_SESSION_EXCHANGE_MAX_SKEW_SECONDS',
    300,
  );
  const trustedSessionExchangeNonceTtlSeconds = envNumber(
    'TRUSTED_SESSION_EXCHANGE_NONCE_TTL_SECONDS',
    600,
  );
  const trustedSessionExchangeApiKeysJson =
    process.env.TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON?.trim() ?? '';
  const adminControlEnabled = envBoolean('AUTH_ADMIN_CONTROL_ENABLED', false);
  const adminControlApiKeysJson = process.env.AUTH_ADMIN_CONTROL_API_KEYS_JSON?.trim() ?? '';
  const adminControlAllowedApiKeyIds = csvEnv('AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS');
  const adminControlMaxSkewSeconds = envNumber('AUTH_ADMIN_CONTROL_MAX_SKEW_SECONDS', 300);
  const adminControlNonceTtlSeconds = envNumber('AUTH_ADMIN_CONTROL_NONCE_TTL_SECONDS', 600);
  const adminBreakGlassMaxTtlSeconds = envNumber('AUTH_ADMIN_BREAK_GLASS_MAX_TTL_SECONDS', 3600);

  if (trustedSessionExchangeEnabled) {
    assert(
      trustedSessionExchangeApiKeysJson,
      'TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON is required when TRUSTED_SESSION_EXCHANGE_ENABLED=true',
    );
  }
  assert(
    trustedSessionExchangeNonceTtlSeconds >= trustedSessionExchangeMaxSkewSeconds,
    'TRUSTED_SESSION_EXCHANGE_NONCE_TTL_SECONDS must be greater than or equal to TRUSTED_SESSION_EXCHANGE_MAX_SKEW_SECONDS',
  );
  if (adminControlEnabled) {
    assert(
      adminControlApiKeysJson,
      'AUTH_ADMIN_CONTROL_API_KEYS_JSON is required when AUTH_ADMIN_CONTROL_ENABLED=true',
    );
    assert(
      adminControlAllowedApiKeyIds.length > 0,
      'AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS is required when AUTH_ADMIN_CONTROL_ENABLED=true',
    );
  }
  assert(
    adminControlNonceTtlSeconds >= adminControlMaxSkewSeconds,
    'AUTH_ADMIN_CONTROL_NONCE_TTL_SECONDS must be greater than or equal to AUTH_ADMIN_CONTROL_MAX_SKEW_SECONDS',
  );
  assert(
    adminBreakGlassMaxTtlSeconds > 0 && adminBreakGlassMaxTtlSeconds <= 86400,
    'AUTH_ADMIN_BREAK_GLASS_MAX_TTL_SECONDS must be between 1 and 86400',
  );
  assert(
    !legacyWalletLoginEnabled || nodeEnv === 'development' || nodeEnv === 'test',
    'LEGACY_WALLET_LOGIN_ENABLED=true is allowed only when NODE_ENV is development or test',
  );
  const dbMigrationUser = optionalEnv('DB_MIGRATION_USER');
  const dbMigrationPassword = optionalEnv('DB_MIGRATION_PASSWORD');
  assert(
    Boolean(dbMigrationUser) === Boolean(dbMigrationPassword),
    'DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together',
  );

  return {
    nodeEnv,
    port: envNumber('PORT', 3005),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT', 5432),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    dbMigrationUser,
    dbMigrationPassword,
    sessionTtlSeconds: envNumber('SESSION_TTL_SECONDS', 3600),
    legacyWalletLoginEnabled,
    corsAllowedOrigins: parseAllowedOrigins(process.env.AUTH_CORS_ALLOWED_ORIGINS),
    corsAllowNoOrigin: envBoolean('AUTH_CORS_ALLOW_NO_ORIGIN', false),
    rateLimitEnabled: envBoolean('AUTH_RATE_LIMIT_ENABLED', true),
    rateLimitRedisUrl: process.env.AUTH_RATE_LIMIT_REDIS_URL?.trim() || undefined,
    rateLimitFailOpen: envBoolean('AUTH_RATE_LIMIT_FAIL_OPEN', false),
    trustedSessionExchangeEnabled,
    trustedSessionExchangeApiKeysJson,
    trustedSessionExchangeMaxSkewSeconds,
    trustedSessionExchangeNonceTtlSeconds,
    adminControlEnabled,
    adminControlApiKeysJson,
    adminControlAllowedApiKeyIds,
    adminControlMaxSkewSeconds,
    adminControlNonceTtlSeconds,
    adminBreakGlassMaxTtlSeconds,
  };
}

export const config = process.env.JEST_WORKER_ID ? ({} as AuthConfig) : loadConfig();
