import path from 'path';

const BASE_ENV: Record<string, string> = {
  PORT: '3601',
  API_KEY: 'oracle-api-key',
  HMAC_SECRET: 'oracle-hmac-secret',
  ESCROW_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  USDC_ADDRESS: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  ORACLE_PRIVATE_KEY: '0x0123456789012345678901234567890123456789012345678901234567890123',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'oracle',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_MIGRATION_USER: '',
  DB_MIGRATION_PASSWORD: '',
  INDEXER_GRAPHQL_URL: 'https://indexer.example.com/graphql',
  INDEXER_GQL_TIMEOUT_MS: '10000',
  RETRY_ATTEMPTS: '3',
  RETRY_DELAY: '1000',
  HMAC_NONCE_TTL_SECONDS: '600',
  NOTIFICATIONS_ENABLED: 'false',
  NOTIFICATIONS_WEBHOOK_URL: '',
  NOTIFICATIONS_COOLDOWN_MS: '300000',
  NOTIFICATIONS_REQUEST_TIMEOUT_MS: '5000',
  ORACLE_MANUAL_APPROVAL_ENABLED: 'false',
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const snapshot = process.env;
  process.env = { ...snapshot, ...BASE_ENV };

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
    jest.resetModules();
  }
}

function loadConfigModule(): typeof import('./config') {
  const modulePath = path.resolve(__dirname, './config');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath) as typeof import('./config');
}

describe('oracle runtime config', () => {
  test('resolves base-sepolia defaults from settlement runtime key', () => {
    withEnv(
      {
        SETTLEMENT_RUNTIME: 'base-sepolia',
        RPC_URL: undefined,
        RPC_FALLBACK_URLS: undefined,
        CHAIN_ID: undefined,
        EXPLORER_BASE_URL: undefined,
        USDC_ADDRESS: undefined,
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
        expect(config.usdcAddress).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
      },
    );
  });

  test('browser no-origin CORS is disabled by default', () => {
    withEnv(
      {
        SETTLEMENT_RUNTIME: 'base-sepolia',
        RPC_URL: undefined,
        RPC_FALLBACK_URLS: undefined,
        CHAIN_ID: undefined,
        EXPLORER_BASE_URL: undefined,
        USDC_ADDRESS: undefined,
      },
      () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();
      expect(config.corsAllowNoOrigin).toBe(false);
      },
    );
  });
});
