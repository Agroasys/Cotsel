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
  jest.resetModules();
  let loaded!: typeof import('../src/config/env');
  jest.isolateModules(() => {
    loaded = jest.requireActual(modulePath) as typeof import('../src/config/env');
  });
  return loaded;
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
    withEnv({ GATEWAY_SETTLEMENT_RUNTIME: 'legacy-runtime' }, () => {
      const { loadConfig } = loadConfigModule();
      expect(() => loadConfig()).toThrow(/Unknown settlement runtime "legacy-runtime"/);
    });
  });

  test('production rejects insecure downstream auth fallback when a protected dependency is configured', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH: 'false',
        GATEWAY_TREASURY_BASE_URL: 'http://127.0.0.1:3200',
        GATEWAY_TREASURY_SERVICE_API_KEY: undefined,
        GATEWAY_TREASURY_SERVICE_API_SECRET: undefined,
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow(
          'GATEWAY_TREASURY_BASE_URL requires a service API key and secret when GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH=false',
        );
      },
    );
  });

  test('production rejects raw private-key gasless relayer custody without explicit emergency exception', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
        GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'raw_private_key',
        GATEWAY_GASLESS_ALLOW_RAW_PRIVATE_KEY_IN_PRODUCTION: 'false',
        GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '10000000000000000000',
        GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '10000000000000000000',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow(
          'Production gasless execution must use KMS/MPC signer custody or explicitly approve the raw-private-key emergency exception',
        );
      },
    );
  });

  test('gasless relayer config exposes pause, custody, failover, and gas-spend caps', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
        GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        GATEWAY_GASLESS_BROADCAST_PAUSED: 'true',
        GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'raw_private_key',
        GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
        GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '100000000000000',
        GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '2',
        GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '1',
        GATEWAY_GASLESS_STUCK_QUEUE_THRESHOLD_MS: '5000',
        GATEWAY_GASLESS_REPEATED_FAILURE_ALERT_THRESHOLD: '2',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();

        expect(config.gaslessBroadcastPaused).toBe(true);
        expect(config.gaslessSignerCustodyMode).toBe('raw_private_key');
        expect(config.rpcFallbackUrls).toEqual(['https://fallback.example.test']);
        expect(config.gaslessMaxFeePerGasWei).toBe(1000000000n);
        expect(config.gaslessMaxNativeCostWei).toBe(100000000000000n);
        expect(config.gaslessLowBalanceAlertWei).toBe(2n);
        expect(config.gaslessMinExecutorBalanceWei).toBe(1n);
        expect(config.gaslessCapacityTargetTxPerDay).toBe(500);
        expect(config.gaslessCapacityBurstMultiplierBasisPoints).toBe(40000);
        expect(config.gaslessCapacitySafetyMarginBasisPoints).toBe(12500);
        expect(config.gaslessCapacityRequiredExecutorBalanceWei).toBe(157500000000000000n);
        expect(config.gaslessCapacityFailClosed).toBe(false);
        expect(config.gaslessStuckQueueThresholdMs).toBe(5000);
        expect(config.gaslessRepeatedFailureAlertThreshold).toBe(2);
      },
    );
  });

  test('gasless relayer capacity policy fails closed when configured for production readiness', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
        GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED: 'true',
        GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
        GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
        GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
        GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '100000000000000000',
        GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '150000000000000000',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow(
          'GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI must cover the configured gasless burst-hour capacity policy when fail-closed capacity is enabled',
        );
      },
    );
  });

  test('gasless relayer capacity policy rejects fractional capacity inputs', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
        GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        GATEWAY_GASLESS_CAPACITY_TARGET_TX_PER_DAY: '500.5',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow(
          'GATEWAY_GASLESS_CAPACITY_TARGET_TX_PER_DAY must be a positive integer',
        );
      },
    );
  });

  test('gasless relayer low-balance alert threshold must protect the minimum executor balance floor', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
        GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '1',
        GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '2',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow(
          'GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI must be >= GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI when both are set',
        );
      },
    );
  });

  test('migration credentials must be configured as a pair', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_CHAIN_ID: undefined,
        DB_MIGRATION_USER: 'gateway_migrator',
        DB_MIGRATION_PASSWORD: undefined,
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow(
          'DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together',
        );
      },
    );
  });

  test('browser no-origin CORS is disabled by default', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_CORS_ALLOW_NO_ORIGIN: undefined,
      },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();
        expect(config.corsAllowNoOrigin).toBe(false);
      },
    );
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
