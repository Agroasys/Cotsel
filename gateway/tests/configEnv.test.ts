/**
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'path';

const BASE_ENV: Record<string, string> = {
  PORT: '3600',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'gateway',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  GATEWAY_AUTH_BASE_URL: 'http://127.0.0.1:4100',
  GATEWAY_INDEXER_GRAPHQL_URL: 'http://127.0.0.1:4350/graphql',
  GATEWAY_ESCROW_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  GATEWAY_ENABLE_MUTATIONS: 'false',
  GATEWAY_WRITE_ALLOWLIST: '',
  GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS: '86400',
  GATEWAY_COMMIT_SHA: 'deadbeef',
  GATEWAY_BUILD_TIME: '2026-03-30T00:00:00.000Z',
  GATEWAY_INDEXER_REQUEST_TIMEOUT_MS: '5000',
  GATEWAY_CORS_ALLOWED_ORIGINS: 'https://cotsel.agroasys.com,https://ops.agroasys.com',
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const snapshot = { ...process.env };

  for (const key of Object.keys(BASE_ENV)) {
    delete process.env[key];
  }

  Object.assign(process.env, BASE_ENV);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    process.env = snapshot;
  }
}

function loadConfigModule(): typeof import('../src/config/env') {
  const modulePath = path.resolve(__dirname, '../src/config/env');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath) as typeof import('../src/config/env');
}

describe('gateway runtime env config', () => {
  test('resolves base-sepolia runtime from canonical runtime key without explicit RPC inputs', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_RPC_FALLBACK_URLS: undefined,
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_EXPLORER_BASE_URL: undefined,
      },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();

        expect(config.settlementRuntimeKey).toBe('base-sepolia');
        expect(config.networkName).toBe('Base Sepolia');
        expect(config.chainId).toBe(84532);
        expect(config.rpcUrl).toBe('https://sepolia.base.org');
        expect(config.explorerBaseUrl).toBe('https://sepolia-explorer.base.org/tx/');
        expect(config.escrowAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
      },
    );
  });

  test('uses canonical checksum addresses when runtime is inferred from explicit chain id', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: undefined,
        GATEWAY_CHAIN_ID: '8453',
        GATEWAY_RPC_URL: 'https://mainnet.base.org',
        GATEWAY_USDC_ADDRESS: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();

        expect(config.settlementRuntimeKey).toBe('base-mainnet');
        expect(config.escrowAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
      },
    );
  });

  test('fails clearly for unknown settlement runtime keys', () => {
    withEnv({ GATEWAY_SETTLEMENT_RUNTIME: 'polkadot-testnet' }, () => {
      const { loadConfig } = loadConfigModule();
      expect(() => loadConfig()).toThrow(/Unknown settlement runtime "polkadot-testnet"/);
    });
  });

  test('parses the gateway CORS allowlist', () => {
    withEnv({ GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia' }, () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();

      expect(config.corsAllowedOrigins).toEqual([
        'https://cotsel.agroasys.com',
        'https://ops.agroasys.com',
      ]);
    });
  });
});
