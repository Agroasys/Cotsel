import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { normalizeAddressOrThrow } from './utils/address';

dotenv.config();

export interface ReconciliationConfig {
  enabled: boolean;
  daemonIntervalMs: number;
  batchSize: number;
  maxTradesPerRun: number;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  rpcUrl: string;
  rpcFallbackUrls: string[];
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  indexerGraphqlUrl: string;
  indexerGraphqlRequestTimeoutMs: number;
  enforceContainerSafeIndexerUrl: boolean;
  notificationsEnabled: boolean;
  notificationsWebhookUrl?: string;
  notificationsCooldownMs: number;
  notificationsRequestTimeoutMs: number;
}

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
  const value = raw ?? env(name);
  const parsed = Number.parseInt(value, 10);
  assert(!Number.isNaN(parsed), `${name} must be a number`);
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return raw.toLowerCase() === 'true';
}

function envAddress(name: string): string {
  const value = env(name);
  return normalizeAddressOrThrow(value, name);
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
    parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ws:' || parsed.protocol === 'wss:',
    `${name} must use http, https, ws, or wss protocol`,
  );

  return value;
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

function assertContainerSafeIndexerUrl(url: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} must be a valid URL, received "${url}"`);
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  assert(
    !loopbackHosts.has(parsed.hostname),
    `${name} must not use localhost/loopback when RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL=true`,
  );
}

export function loadConfig(): ReconciliationConfig {
  const notificationsEnabled = envBool('NOTIFICATIONS_ENABLED', false);
  const notificationsWebhookUrl = process.env.NOTIFICATIONS_WEBHOOK_URL;

  if (notificationsEnabled) {
    assert(notificationsWebhookUrl, 'NOTIFICATIONS_WEBHOOK_URL is required when NOTIFICATIONS_ENABLED=true');
  }

  const indexerGraphqlUrl = envUrl('INDEXER_GRAPHQL_URL');
  const indexerGraphqlTimeoutMinMs = envNumber('INDEXER_GQL_TIMEOUT_MIN_MS', 1000);
  const indexerGraphqlTimeoutMaxMs = envNumber('INDEXER_GQL_TIMEOUT_MAX_MS', 60000);
  const indexerGraphqlRequestTimeoutMs = envNumber('INDEXER_GQL_TIMEOUT_MS', 10000);
  const enforceContainerSafeIndexerUrl = envBool('RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL', false);

  if (enforceContainerSafeIndexerUrl) {
    assertContainerSafeIndexerUrl(indexerGraphqlUrl, 'INDEXER_GRAPHQL_URL');
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

  const config: ReconciliationConfig = {
    enabled: envBool('RECONCILIATION_ENABLED', false),
    daemonIntervalMs: envNumber('RECONCILIATION_DAEMON_INTERVAL_MS', 60000),
    batchSize: envNumber('RECONCILIATION_BATCH_SIZE', 100),
    maxTradesPerRun: envNumber('RECONCILIATION_MAX_TRADES_PER_RUN', 1000),
    dbHost: env('DB_HOST'),
    dbPort: envNumber('DB_PORT'),
    dbName: env('DB_NAME'),
    dbUser: env('DB_USER'),
    dbPassword: env('DB_PASSWORD'),
    rpcUrl: envUrl('RPC_URL'),
    rpcFallbackUrls: parseUrlList(process.env.RPC_FALLBACK_URLS),
    chainId: envNumber('CHAIN_ID'),
    escrowAddress: envAddress('ESCROW_ADDRESS'),
    usdcAddress: envAddress('USDC_ADDRESS'),
    indexerGraphqlUrl,
    indexerGraphqlRequestTimeoutMs,
    enforceContainerSafeIndexerUrl,
    notificationsEnabled,
    notificationsWebhookUrl,
    notificationsCooldownMs: envNumber('NOTIFICATIONS_COOLDOWN_MS', 300000),
    notificationsRequestTimeoutMs: envNumber('NOTIFICATIONS_REQUEST_TIMEOUT_MS', 5000),
  };

  assert(config.daemonIntervalMs >= 1000, 'RECONCILIATION_DAEMON_INTERVAL_MS must be >= 1000');
  assert(config.batchSize > 0, 'RECONCILIATION_BATCH_SIZE must be > 0');
  assert(config.maxTradesPerRun > 0, 'RECONCILIATION_MAX_TRADES_PER_RUN must be > 0');
  assert(config.notificationsCooldownMs >= 0, 'NOTIFICATIONS_COOLDOWN_MS must be >= 0');
  assert(config.notificationsRequestTimeoutMs >= 1000, 'NOTIFICATIONS_REQUEST_TIMEOUT_MS must be >= 1000');

  return config;
}

export const config = loadConfig();
