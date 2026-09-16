import { strict as assert } from 'node:assert';
import { getAddress, isAddress } from 'ethers';

export interface RelayerConfig {
  port: number;
  nodeEnv: string;
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  kmsKeyId: string;
  kmsExpectedAddress: string;
  apiKeysJson: string;
  redisUrl?: string;
  authMaxSkewSeconds: number;
  authNonceTtlSeconds: number;
  requestReplayTtlSeconds: number;
  maxGasLimit: bigint;
  maxFeePerGasWei: bigint;
  maxNativeCostWei: bigint;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  assert(value, `${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  assert(Number.isSafeInteger(value) && Number(value) > 0, `${name} must be a positive integer`);
  return Number(value);
}

function positiveBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  assert(!raw || /^\d+$/.test(raw), `${name} must be an unsigned integer`);
  const value = raw ? BigInt(raw) : fallback;
  assert(value > 0n, `${name} must be greater than zero`);
  return value;
}

function address(name: string): string {
  const value = required(name);
  assert(isAddress(value), `${name} must be an EVM address`);
  const canonical = getAddress(value);
  assert(canonical !== '0x0000000000000000000000000000000000000000', `${name} must be non-zero`);
  return canonical;
}

export function loadRelayerConfig(): RelayerConfig {
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
  const custodyMode = required('RELAYER_SIGNER_CUSTODY_MODE');
  assert(custodyMode === 'kms', 'RELAYER_SIGNER_CUSTODY_MODE must be kms');
  for (const name of [
    'RELAYER_PRIVATE_KEY',
    'GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY',
    'GATEWAY_EXECUTOR_PRIVATE_KEY',
  ]) {
    assert(!process.env[name]?.trim(), `${name} must not be set in the relayer runtime`);
  }

  const redisUrl = process.env.RELAYER_REDIS_URL?.trim() || undefined;
  assert(nodeEnv !== 'production' || redisUrl, 'RELAYER_REDIS_URL is required in production');
  assert(
    nodeEnv !== 'production' || redisUrl?.startsWith('rediss://'),
    'RELAYER_REDIS_URL must use rediss:// in production',
  );

  const config: RelayerConfig = {
    port: positiveInteger('PORT', 3300),
    nodeEnv,
    chainId: positiveInteger('RELAYER_CHAIN_ID'),
    escrowAddress: address('RELAYER_ESCROW_ADDRESS'),
    usdcAddress: address('RELAYER_USDC_ADDRESS'),
    kmsKeyId: required('RELAYER_KMS_KEY_ID'),
    kmsExpectedAddress: address('RELAYER_KMS_EXPECTED_ADDRESS'),
    apiKeysJson: required('RELAYER_API_KEYS_JSON'),
    redisUrl,
    authMaxSkewSeconds: positiveInteger('RELAYER_AUTH_MAX_SKEW_SECONDS', 300),
    authNonceTtlSeconds: positiveInteger('RELAYER_AUTH_NONCE_TTL_SECONDS', 600),
    requestReplayTtlSeconds: positiveInteger('RELAYER_REQUEST_REPLAY_TTL_SECONDS', 900),
    maxGasLimit: positiveBigInt('RELAYER_MAX_GAS_LIMIT', 1_500_000n),
    maxFeePerGasWei: positiveBigInt('RELAYER_MAX_FEE_PER_GAS_WEI', 50_000_000_000n),
    maxNativeCostWei: positiveBigInt('RELAYER_MAX_NATIVE_COST_WEI', 100_000_000_000_000_000n),
  };
  assert(
    config.authNonceTtlSeconds >= config.authMaxSkewSeconds,
    'RELAYER_AUTH_NONCE_TTL_SECONDS must be at least RELAYER_AUTH_MAX_SKEW_SECONDS',
  );
  assert(
    config.requestReplayTtlSeconds >= config.authNonceTtlSeconds,
    'RELAYER_REQUEST_REPLAY_TTL_SECONDS must be at least RELAYER_AUTH_NONCE_TTL_SECONDS',
  );
  return config;
}
