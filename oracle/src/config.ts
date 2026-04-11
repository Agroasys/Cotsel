import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { ethers } from 'ethers';
import { parseAllowedOrigins } from '@agroasys/shared-edge';
import { resolveSettlementRuntime } from '@agroasys/sdk';
import { OracleConfig } from './types';

dotenv.config();

function validateEnv(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function validateEnvUrl(name: string): string {
  const value = validateEnv(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL, received "${value}"`);
  }
  assert(
    parsed.protocol === 'http:' || parsed.protocol === 'https:',
    `${name} must use http or https protocol`,
  );
  return value.replace(/\/$/, '');
}

function validateEnvAddress(name: string): string {
  const value = validateEnv(name);
  assert(ethers.isAddress(value), `${name} must be a valid EVM address, received "${value}"`);
  return ethers.getAddress(value);
}

function validateEnvNumber(name: string, fallback?: number): number {
  const value = process.env[name];
  if ((value === undefined || value === '') && fallback !== undefined) {
    return fallback;
  }

  const required = value ?? validateEnv(name);
  const num = parseInt(required, 10);
  assert(!isNaN(num), `${name} must be a number`);
  return num;
}

function validateEnvBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
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

export function loadConfig(): OracleConfig {
  try {
    const nodeEnv = process.env.NODE_ENV || 'development';
    const notificationsEnabled = validateEnvBool('NOTIFICATIONS_ENABLED', false);
    const notificationsWebhookUrl = process.env.NOTIFICATIONS_WEBHOOK_URL;
    const indexerGraphqlTimeoutMinMs = validateEnvNumber('INDEXER_GQL_TIMEOUT_MIN_MS', 1000);
    const indexerGraphqlTimeoutMaxMs = validateEnvNumber('INDEXER_GQL_TIMEOUT_MAX_MS', 60000);
    const indexerGraphqlRequestTimeoutMs = validateEnvNumber('INDEXER_GQL_TIMEOUT_MS', 10000);
    const retryAttempts = validateEnvNumber('RETRY_ATTEMPTS', 3);
    const retryDelay = validateEnvNumber('RETRY_DELAY', 1000);
    const hmacNonceTtlSeconds = validateEnvNumber('HMAC_NONCE_TTL_SECONDS', 600);
    const manualApprovalEnabled = validateEnvBool('ORACLE_MANUAL_APPROVAL_ENABLED', false);
    const dbMigrationUser = optionalEnv('DB_MIGRATION_USER');
    const dbMigrationPassword = optionalEnv('DB_MIGRATION_PASSWORD');

    if (notificationsEnabled) {
      assert(
        notificationsWebhookUrl,
        'NOTIFICATIONS_WEBHOOK_URL is required when NOTIFICATIONS_ENABLED=true',
      );
    }
    assert(
      Boolean(dbMigrationUser) === Boolean(dbMigrationPassword),
      'DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together',
    );

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

    const runtime = resolveSettlementRuntime({
      runtimeKey: optionalEnv('SETTLEMENT_RUNTIME'),
      rpcUrl: process.env.RPC_URL ? validateEnvUrl('RPC_URL') : undefined,
      rpcFallbackUrls: parseUrlList(process.env.RPC_FALLBACK_URLS),
      chainId: process.env.CHAIN_ID ? validateEnvNumber('CHAIN_ID') : null,
      explorerBaseUrl: optionalEnv('EXPLORER_BASE_URL'),
      escrowAddress: validateEnvAddress('ESCROW_ADDRESS'),
      usdcAddress: optionalEnv('USDC_ADDRESS') ? validateEnvAddress('USDC_ADDRESS') : null,
    });

    const config: OracleConfig = {
      nodeEnv,
      // server
      port: validateEnvNumber('PORT'),
      apiKey: validateEnv('API_KEY'),
      hmacSecret: validateEnv('HMAC_SECRET'),
      corsAllowedOrigins: parseAllowedOrigins(process.env.ORACLE_CORS_ALLOWED_ORIGINS),
      corsAllowNoOrigin: validateEnvBool('ORACLE_CORS_ALLOW_NO_ORIGIN', false),
      rateLimitEnabled: validateEnvBool('ORACLE_RATE_LIMIT_ENABLED', true),
      rateLimitRedisUrl: process.env.ORACLE_RATE_LIMIT_REDIS_URL?.trim() || undefined,

      // network
      rpcUrl: runtime.rpcUrl,
      rpcFallbackUrls: runtime.rpcFallbackUrls,
      chainId: runtime.chainId,
      escrowAddress: runtime.escrowAddress
        ? ethers.getAddress(runtime.escrowAddress)
        : validateEnvAddress('ESCROW_ADDRESS'),
      usdcAddress: runtime.usdcAddress
        ? ethers.getAddress(runtime.usdcAddress)
        : validateEnvAddress('USDC_ADDRESS'),
      settlementRuntimeKey: runtime.runtimeKey,
      networkName: runtime.networkName,
      explorerBaseUrl: runtime.explorerBaseUrl,
      oraclePrivateKey: validateEnv('ORACLE_PRIVATE_KEY'),

      // oracle db
      dbHost: validateEnv('DB_HOST'),
      dbPort: validateEnvNumber('DB_PORT'),
      dbName: validateEnv('DB_NAME'),
      dbUser: validateEnv('DB_USER'),
      dbPassword: validateEnv('DB_PASSWORD'),
      dbMigrationUser,
      dbMigrationPassword,

      // indexer graphql api
      indexerGraphqlUrl: validateEnvUrl('INDEXER_GRAPHQL_URL'),
      indexerGraphqlRequestTimeoutMs,

      // retry
      retryAttempts,
      retryDelay,
      hmacNonceTtlSeconds,

      // notifications
      notificationsEnabled,
      notificationsWebhookUrl,
      notificationsCooldownMs: validateEnvNumber('NOTIFICATIONS_COOLDOWN_MS', 300000),
      notificationsRequestTimeoutMs: validateEnvNumber('NOTIFICATIONS_REQUEST_TIMEOUT_MS', 5000),
      manualApprovalEnabled,
    };

    assert(
      config.retryAttempts >= 0 && config.retryAttempts <= 10,
      'RETRY_ATTEMPTS must be between 0 and 10',
    );
    assert(
      config.retryDelay >= 100 && config.retryDelay <= 30000,
      'RETRY_DELAY must be between 100 and 30000',
    );
    assert(
      config.hmacNonceTtlSeconds >= 60 && config.hmacNonceTtlSeconds <= 3600,
      'HMAC_NONCE_TTL_SECONDS must be between 60 and 3600',
    );
    assert(config.notificationsCooldownMs >= 0, 'NOTIFICATIONS_COOLDOWN_MS must be >= 0');
    assert(
      config.notificationsRequestTimeoutMs >= 1000,
      'NOTIFICATIONS_REQUEST_TIMEOUT_MS must be >= 1000',
    );

    return config;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Oracle config validation failed',
        error: normalizedError.message,
        service: 'oracle',
        env: process.env.NODE_ENV || 'development',
      }),
    );
    throw normalizedError;
  }
}

export const config = loadConfig();
