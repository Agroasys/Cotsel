import dotenv from 'dotenv';
import { strict as assert } from 'assert';
import { parsePostgresSslMode, type PostgresSslMode } from '@agroasys/shared-db';
import { assertDeploymentPins, type DeploymentProfile } from './preflight';

dotenv.config();

export interface IndexerConfig {
  // profile
  cotselEnvironment: DeploymentProfile;

  // db
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbSslMode: PostgresSslMode;

  // network
  gatewayUrl: string | null;
  rpcEndpoint: string;
  rpcFallbackEndpoints: string[];
  chainId: number;
  startBlock: number;
  rateLimit: number;
  rpcCapacity: number | null;
  rpcMaxBatchCallSize: number | null;
  rpcRequestTimeoutMs: number | null;
  rpcRetryAttempts: number | null;
  rpcHeadPollIntervalMs: number | null;
  rpcIngestDisabled: boolean;
  finalityConfirmationBlocks: number;
  prometheusPort: number | null;
  readinessPort: number;
  readinessMaxCheckpointLagBlocks: number;

  // contract
  contractAddress: string;
  expectedContractCodehash: string | null;
  expectedAbiFingerprint: string | null;
  verifyStartBlockCode: boolean;

  // poison-log alerting
  notificationsEnabled: boolean;
  notificationsWebhookUrl: string | null;
  notificationsCooldownMs: number;
  notificationsRequestTimeoutMs: number;
}

export const DEFAULT_READINESS_PORT = 8090;
// About five minutes of Base blocks beyond the configured confirmations.
export const DEFAULT_READINESS_MAX_CHECKPOINT_LAG_BLOCKS = 150;

function validateEnv(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Whole decimal integers only, within [min, max]. `parseInt` would accept
 * "12abc", "1e3" or "-0" and silently start the indexer on a different range.
 */
function parseInteger(name: string, value: string, min: number, max: number): number {
  assert(/^-?\d+$/.test(value), `${name} must be an integer`);
  const num = Number(value);
  assert(
    Number.isSafeInteger(num) && num >= min && num <= max,
    `${name} must be between ${min} and ${max}`,
  );
  return num;
}

function optionalEnvNumber(name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number | null {
  const value = optionalEnv(name);
  return value === null ? null : parseInteger(name, value, min, max);
}

function optionalEnvBoolean(name: string): boolean | null {
  const value = optionalEnv(name);
  if (value === null) {
    return null;
  }

  assert(value === 'true' || value === 'false', `${name} must be true or false`);
  return value === 'true';
}

function validateEnvNumber(name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  return parseInteger(name, validateEnv(name).trim(), min, max);
}

const MAX_PORT = 65535;
const MAX_BLOCK = 2 ** 31 - 1; // Subsquid persists checkpoints as int4.

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

function deploymentProfile(): DeploymentProfile {
  const raw = process.env.COTSEL_ENVIRONMENT?.trim().toLowerCase();
  if (!raw) {
    return 'local';
  }
  assert(
    raw === 'local' || raw === 'staging' || raw === 'production',
    'COTSEL_ENVIRONMENT must be one of: local, staging, production',
  );
  return raw;
}

export function loadConfig(): IndexerConfig {
  try {
    const config: IndexerConfig = {
      cotselEnvironment: deploymentProfile(),
      dbHost: validateEnv('DB_HOST'),
      dbPort: validateEnvNumber('DB_PORT', 1, MAX_PORT),
      dbName: validateEnv('DB_NAME'),
      dbUser: validateEnv('DB_USER'),
      dbPassword: validateEnv('DB_PASSWORD'),
      dbSslMode: parsePostgresSslMode(process.env.DB_SSL_MODE),
      gatewayUrl: optionalEnv('GATEWAY_URL'),
      rpcEndpoint: validateEnv('RPC_ENDPOINT'),
      rpcFallbackEndpoints: parseUrlList(process.env.RPC_FALLBACK_ENDPOINTS),
      chainId: validateEnvNumber('CHAIN_ID', 1),
      startBlock: validateEnvNumber('START_BLOCK', 0, MAX_BLOCK),
      rateLimit: validateEnvNumber('RATE_LIMIT', 1),
      rpcCapacity: optionalEnvNumber('RPC_CAPACITY'),
      rpcMaxBatchCallSize: optionalEnvNumber('RPC_MAX_BATCH_CALL_SIZE'),
      rpcRequestTimeoutMs: optionalEnvNumber('RPC_REQUEST_TIMEOUT_MS'),
      rpcRetryAttempts: optionalEnvNumber('RPC_RETRY_ATTEMPTS', 0),
      rpcHeadPollIntervalMs: optionalEnvNumber('RPC_HEAD_POLL_INTERVAL_MS'),
      rpcIngestDisabled: optionalEnvBoolean('RPC_INGEST_DISABLED') ?? false,
      finalityConfirmationBlocks: validateEnvNumber('FINALITY_CONFIRMATION_BLOCKS', 0, MAX_BLOCK),
      prometheusPort: optionalEnvNumber('PROMETHEUS_PORT', 1, MAX_PORT),
      readinessPort: optionalEnvNumber('READINESS_PORT', 1, MAX_PORT) ?? DEFAULT_READINESS_PORT,
      readinessMaxCheckpointLagBlocks:
        optionalEnvNumber('READINESS_MAX_CHECKPOINT_LAG_BLOCKS', 0, MAX_BLOCK) ??
        DEFAULT_READINESS_MAX_CHECKPOINT_LAG_BLOCKS,
      contractAddress: validateEnv('CONTRACT_ADDRESS').toLowerCase(),
      expectedContractCodehash: optionalEnv('EXPECTED_CONTRACT_CODEHASH'),
      expectedAbiFingerprint: optionalEnv('EXPECTED_ABI_FINGERPRINT'),
      verifyStartBlockCode: optionalEnvBoolean('VERIFY_START_BLOCK_CODE') ?? true,
      notificationsEnabled: optionalEnvBoolean('NOTIFICATIONS_ENABLED') ?? false,
      notificationsWebhookUrl: optionalEnv('NOTIFICATIONS_WEBHOOK_URL'),
      notificationsCooldownMs: optionalEnvNumber('NOTIFICATIONS_COOLDOWN_MS', 0) ?? 300000,
      notificationsRequestTimeoutMs: optionalEnvNumber('NOTIFICATIONS_REQUEST_TIMEOUT_MS') ?? 5000,
    };

    assert(
      config.prometheusPort === null || config.prometheusPort !== config.readinessPort,
      'PROMETHEUS_PORT and READINESS_PORT must differ',
    );
    assert(
      !config.notificationsEnabled || config.notificationsWebhookUrl,
      'NOTIFICATIONS_WEBHOOK_URL is required when NOTIFICATIONS_ENABLED is true',
    );
    assert(
      config.expectedContractCodehash === null ||
        /^0x[0-9a-fA-F]{64}$/.test(config.expectedContractCodehash),
      'EXPECTED_CONTRACT_CODEHASH must be a 32-byte hex string',
    );
    assert(
      config.expectedAbiFingerprint === null ||
        /^[0-9a-f]{64}$/.test(config.expectedAbiFingerprint),
      'EXPECTED_ABI_FINGERPRINT must be a sha256 hex digest',
    );

    assertDeploymentPins({
      profile: config.cotselEnvironment,
      expectedContractCodehash: config.expectedContractCodehash,
      expectedAbiFingerprint: config.expectedAbiFingerprint,
      notificationsEnabled: config.notificationsEnabled,
      notificationsWebhookUrl: config.notificationsWebhookUrl,
    });

    return config;
  } catch (error) {
    console.error('indexer config failed:', error);
    process.exit(1);
  }
}
