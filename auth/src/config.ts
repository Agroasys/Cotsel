/**
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import { strict as assert } from 'assert';
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

function loadConfig(): AuthConfig {
  const trustedSessionExchangeEnabled = envBoolean(
    'TRUSTED_SESSION_EXCHANGE_ENABLED',
    false,
  );
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

  return {
    port: envNumber('PORT', 3005),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT', 5432),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    sessionTtlSeconds: envNumber('SESSION_TTL_SECONDS', 3600),
    trustedSessionExchangeEnabled,
    trustedSessionExchangeApiKeysJson,
    trustedSessionExchangeMaxSkewSeconds,
    trustedSessionExchangeNonceTtlSeconds,
  };
}

export const config = loadConfig();
