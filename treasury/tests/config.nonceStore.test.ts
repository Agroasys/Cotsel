const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3200',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'agroasys_treasury',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_MIGRATION_USER: '',
  DB_MIGRATION_PASSWORD: '',
  INDEXER_GRAPHQL_URL: 'http://localhost:4350/graphql',
  TREASURY_INGEST_BATCH_SIZE: '100',
  TREASURY_INGEST_MAX_EVENTS: '2000',
  AUTH_ENABLED: 'false',
  API_KEYS_JSON: '[]',
  HMAC_SECRET: '',
  AUTH_MAX_SKEW_SECONDS: '300',
  AUTH_NONCE_TTL_SECONDS: '600',
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
      { NODE_ENV: 'production', AUTH_ENABLED: undefined, HMAC_SECRET: 'shared-secret' },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();
        expect(config.authEnabled).toBe(true);
      },
    );
  });

  test('redis mode requires REDIS_URL', () => {
    withEnv({ NODE_ENV: 'production', NONCE_STORE: 'redis', REDIS_URL: '' }, () => {
      expect(() => loadConfigModule()).toThrow('REDIS_URL is required when NONCE_STORE=redis');
    });
  });

  test('migration credentials must be configured as a pair', () => {
    withEnv({ DB_MIGRATION_USER: 'treasury_migrator', DB_MIGRATION_PASSWORD: undefined }, () => {
      expect(() => loadConfigModule()).toThrow(
        'DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together',
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
