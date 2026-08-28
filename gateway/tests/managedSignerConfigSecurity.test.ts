/**
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'path';

const REQUIRED_ENV: Record<string, string> = {
  PORT: '3600',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'gateway',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL_MODE: 'disable',
  GATEWAY_AUTH_BASE_URL: 'http://127.0.0.1:4100',
  GATEWAY_INDEXER_GRAPHQL_URL: 'http://127.0.0.1:4350/graphql',
  GATEWAY_ESCROW_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  GATEWAY_ENABLE_MUTATIONS: 'false',
  GATEWAY_WRITE_ALLOWLIST: '',
  GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS: '86400',
  GATEWAY_COMMIT_SHA: 'deadbeef',
  GATEWAY_BUILD_TIME: '2026-03-30T00:00:00.000Z',
  GATEWAY_INDEXER_REQUEST_TIMEOUT_MS: '5000',
  GATEWAY_CORS_ALLOWED_ORIGINS: 'https://cotsel.agroasys.com',
  GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH: 'true',
  GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
  GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
  GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
  GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'mpc',
  GATEWAY_GASLESS_MANAGED_SIGNER_URL: 'https://signer.example.test',
  GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY: '',
  GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '10000000000000000000',
  GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '10000000000000000000',
};

test('managed gasless custody rejects missing signer authentication', () => {
  const snapshot = { ...process.env };
  Object.assign(process.env, REQUIRED_ENV);
  delete process.env.GATEWAY_RPC_URL;
  delete process.env.GATEWAY_CHAIN_ID;

  try {
    const modulePath = path.resolve(__dirname, '../src/config/env');
    jest.resetModules();
    let loaded!: typeof import('../src/config/env');
    jest.isolateModules(() => {
      loaded = jest.requireActual(modulePath) as typeof import('../src/config/env');
    });
    expect(() => loaded.loadConfig()).toThrow(
      'Managed gasless signer custody requires GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY',
    );
  } finally {
    process.env = snapshot;
  }
});
