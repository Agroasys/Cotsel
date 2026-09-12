import { loadRelayerConfig } from '../src/config';
import { relayerWallet } from './helpers';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: '3300',
  RELAYER_API_KEYS_JSON: '{"id":"gateway","secret":"secret","active":true}',
  RELAYER_AUTH_MAX_SKEW_SECONDS: '300',
  RELAYER_AUTH_NONCE_TTL_SECONDS: '600',
  RELAYER_CHAIN_ID: '84532',
  RELAYER_ESCROW_ADDRESS: '0x1000000000000000000000000000000000000001',
  RELAYER_KMS_EXPECTED_ADDRESS: relayerWallet.address,
  RELAYER_KMS_KEY_ID: 'alias/cotsel-staging-relayer-signer',
  RELAYER_REDIS_URL: 'rediss://redis.example.test:6379',
  RELAYER_REQUEST_REPLAY_TTL_SECONDS: '900',
  RELAYER_SIGNER_CUSTODY_MODE: 'kms',
  RELAYER_USDC_ADDRESS: '0x2000000000000000000000000000000000000002',
};

function withEnv(overrides: Record<string, string | undefined>, callback: () => void): void {
  const snapshot = { ...process.env };
  process.env = { ...snapshot, ...BASE_ENV };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    callback();
  } finally {
    process.env = snapshot;
  }
}

test('loads a production KMS-only relayer configuration', () => {
  withEnv({}, () => {
    expect(loadRelayerConfig()).toMatchObject({
      chainId: 84532,
      kmsExpectedAddress: relayerWallet.address,
      kmsKeyId: 'alias/cotsel-staging-relayer-signer',
      nodeEnv: 'production',
    });
  });
});

test.each([
  ['raw custody mode', { RELAYER_SIGNER_CUSTODY_MODE: 'raw_private_key' }],
  ['private key material', { RELAYER_PRIVATE_KEY: `0x${'1'.repeat(64)}` }],
  ['missing Redis replay store', { RELAYER_REDIS_URL: undefined }],
  ['wrong expected address', { RELAYER_KMS_EXPECTED_ADDRESS: 'not-an-address' }],
] as const)('rejects %s', (_name, overrides) => {
  withEnv(overrides, () => expect(() => loadRelayerConfig()).toThrow());
});
