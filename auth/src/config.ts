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
    trustedSessionExchangeEnabled,
    trustedSessionExchangeApiKeysJson,
    trustedSessionExchangeMaxSkewSeconds,
    trustedSessionExchangeNonceTtlSeconds,
  };
}

export const config = loadConfig();
