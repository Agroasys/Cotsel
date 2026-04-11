import dotenv from 'dotenv';
import { strict as assert } from 'assert';

dotenv.config();

export interface IndexerConfig {
  // db
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;

  // network
  gatewayUrl: string | null;
  rpcEndpoint: string;
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

  // contract
  contractAddress: string;

  // graphql
  graphqlPort: number;
}

function validateEnv(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function optionalEnvNumber(name: string): number | null {
  const value = optionalEnv(name);
  if (value === null) {
    return null;
  }

  const num = parseInt(value, 10);
  assert(!isNaN(num), `${name} must be a number`);
  return num;
}

function optionalEnvBoolean(name: string): boolean | null {
  const value = optionalEnv(name);
  if (value === null) {
    return null;
  }

  assert(value === 'true' || value === 'false', `${name} must be true or false`);
  return value === 'true';
}

function validateEnvNumber(name: string): number {
  const value = validateEnv(name);
  const num = parseInt(value, 10);
  assert(!isNaN(num), `${name} must be a number`);
  return num;
}

export function loadConfig(): IndexerConfig {
  try {
    const config: IndexerConfig = {
      dbHost: validateEnv('DB_HOST'),
      dbPort: validateEnvNumber('DB_PORT'),
      dbName: validateEnv('DB_NAME'),
      dbUser: validateEnv('DB_USER'),
      dbPassword: validateEnv('DB_PASSWORD'),
      gatewayUrl: optionalEnv('GATEWAY_URL'),
      rpcEndpoint: validateEnv('RPC_ENDPOINT'),
      startBlock: validateEnvNumber('START_BLOCK'),
      rateLimit: validateEnvNumber('RATE_LIMIT'),
      rpcCapacity: optionalEnvNumber('RPC_CAPACITY'),
      rpcMaxBatchCallSize: optionalEnvNumber('RPC_MAX_BATCH_CALL_SIZE'),
      rpcRequestTimeoutMs: optionalEnvNumber('RPC_REQUEST_TIMEOUT_MS'),
      rpcRetryAttempts: optionalEnvNumber('RPC_RETRY_ATTEMPTS'),
      rpcHeadPollIntervalMs: optionalEnvNumber('RPC_HEAD_POLL_INTERVAL_MS'),
      rpcIngestDisabled: optionalEnvBoolean('RPC_INGEST_DISABLED') ?? false,
      finalityConfirmationBlocks: validateEnvNumber('FINALITY_CONFIRMATION_BLOCKS'),
      prometheusPort: optionalEnvNumber('PROMETHEUS_PORT'),
      contractAddress: validateEnv('CONTRACT_ADDRESS').toLowerCase(),
      graphqlPort: validateEnvNumber('GRAPHQL_PORT'),
    };

    return config;
  } catch (error) {
    console.error('indexer config failed:', error);
    process.exit(1);
  }
}
