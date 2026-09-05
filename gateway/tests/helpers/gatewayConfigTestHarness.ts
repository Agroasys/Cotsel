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
  DB_SSL_MODE: 'disable',
  DB_MIGRATION_USER: '',
  DB_MIGRATION_PASSWORD: '',
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
  GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH: 'true',
};

export function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const snapshot = { ...process.env };

  for (const key of Object.keys(BASE_ENV)) delete process.env[key];
  Object.assign(process.env, BASE_ENV);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    fn();
  } finally {
    process.env = snapshot;
  }
}

export function loadConfigModule(): typeof import('../../src/config/env') {
  const modulePath = path.resolve(__dirname, '../../src/config/env');
  jest.resetModules();
  let loaded!: typeof import('../../src/config/env');
  jest.isolateModules(() => {
    loaded = jest.requireActual(modulePath) as typeof import('../../src/config/env');
  });
  return loaded;
}
