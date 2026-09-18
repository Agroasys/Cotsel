const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3200',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'agroasys_treasury',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL_MODE: 'disable',
  INDEXER_GRAPHQL_URL: 'http://localhost:4350/graphql',
  TREASURY_INGEST_BATCH_SIZE: '100',
  TREASURY_INGEST_MAX_EVENTS: '2000',
  AUTH_ENABLED: 'true',
  API_KEYS_JSON: '[{"id":"gateway-internal","secret":"test-shared-secret","active":true}]',
  HMAC_SECRET: 'test-shared-secret',
  AUTH_MAX_SKEW_SECONDS: '300',
  AUTH_NONCE_TTL_SECONDS: '600',
  TREASURY_OPERATOR_DELEGATION_API_KEYS: 'gateway-internal',
};

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const original = process.env;
  process.env = { ...original, ...BASE_ENV };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    process.env = original;
    jest.resetModules();
  }
}

function loadConfigModule(): typeof import('../src/config') {
  jest.resetModules();
  let loaded!: typeof import('../src/config');
  jest.isolateModules(() => {
    loaded = jest.requireActual('../src/config') as typeof import('../src/config');
  });
  return loaded;
}

describe('treasury nonce store config', () => {
  test('production refuses to start without a named delegating caller', () => {
    withEnv({ NODE_ENV: 'production', TREASURY_OPERATOR_DELEGATION_API_KEYS: undefined }, () => {
      expect(() => loadConfigModule()).toThrow(
        'NODE_ENV=production requires TREASURY_OPERATOR_DELEGATION_API_KEYS',
      );
    });
  });

  test('a delegating caller must be a configured internal mutation key', () => {
    withEnv({ TREASURY_OPERATOR_DELEGATION_API_KEYS: 'not-a-configured-key' }, () => {
      expect(() => loadConfigModule()).toThrow(
        'TREASURY_OPERATOR_DELEGATION_API_KEYS names not-a-configured-key, which is not a configured API key',
      );
    });
  });

  test('delegation is empty unless a deployment names a caller', () => {
    withEnv({ TREASURY_OPERATOR_DELEGATION_API_KEYS: undefined }, () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();
      expect(config.internalMutationApiKeys).toContain('gateway-internal');
      expect(config.operatorDelegationApiKeys).toEqual([]);
    });
  });

  test('production rejects in-memory nonce store', () => {
    withEnv({ NODE_ENV: 'production', NONCE_STORE: 'inmemory' }, () => {
      expect(() => loadConfigModule()).toThrow(
        'NONCE_STORE=inmemory is not allowed when NODE_ENV=production',
      );
    });
  });

  test('production defaults to postgres when REDIS_URL is not set', () => {
    withEnv({ NODE_ENV: 'production', NONCE_STORE: undefined, REDIS_URL: undefined }, () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();
      expect(config.nonceStore).toBe('postgres');
    });
  });

  test('production defaults to redis when REDIS_URL is set', () => {
    withEnv(
      { NODE_ENV: 'production', NONCE_STORE: undefined, REDIS_URL: 'redis://localhost:6379' },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();
        expect(config.nonceStore).toBe('redis');
        expect(config.nonceRedisUrl).toBe('redis://localhost:6379');
      },
    );
  });

  test('production enables service auth by default', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        AUTH_ENABLED: undefined,
        HMAC_SECRET: 'shared-secret',
        API_KEYS_JSON: '[{"id":"gateway-internal","secret":"shared-secret","active":true}]',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();
        expect(config.authEnabled).toBe(true);
      },
    );
  });

  test('production cannot explicitly disable service authentication', () => {
    withEnv({ NODE_ENV: 'production', AUTH_ENABLED: 'false', NONCE_STORE: 'postgres' }, () => {
      expect(() => loadConfigModule()).toThrow(
        'AUTH_ENABLED=false is not allowed when NODE_ENV=production',
      );
    });
  });

  test('redis mode requires REDIS_URL', () => {
    withEnv({ NODE_ENV: 'production', NONCE_STORE: 'redis', REDIS_URL: '' }, () => {
      expect(() => loadConfigModule()).toThrow('REDIS_URL is required when NONCE_STORE=redis');
    });
  });

  test('Postgres SSL mode is explicit and validated', () => {
    withEnv({ DB_SSL_MODE: 'require' }, () => {
      const { loadConfig } = loadConfigModule();
      expect(loadConfig().dbSslMode).toBe('require');
    });

    withEnv({ DB_SSL_MODE: 'no-verify' }, () => {
      expect(() => loadConfigModule()).toThrow(
        'DB_SSL_MODE must be one of disable, require, or verify-full',
      );
    });
  });

  test('browser no-origin CORS is disabled by default', () => {
    withEnv({}, () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();
      expect(config.corsAllowNoOrigin).toBe(false);
    });
  });
});
