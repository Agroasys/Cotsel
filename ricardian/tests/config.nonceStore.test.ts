const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3100',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'agroasys_ricardian',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL_MODE: 'disable',
  DB_MIGRATION_USER: '',
  DB_MIGRATION_PASSWORD: '',
  AUTH_ENABLED: 'true',
  API_KEYS_JSON: '[]',
  HMAC_SECRET: 'test-shared-secret',
  AUTH_MAX_SKEW_SECONDS: '300',
  AUTH_NONCE_TTL_SECONDS: '600',
  RATE_LIMIT_ENABLED: 'false',
  RATE_LIMIT_REDIS_URL: '',
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

describe('ricardian nonce store config', () => {
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

  test('production enables service auth and request rate limiting by default', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        AUTH_ENABLED: undefined,
        HMAC_SECRET: 'shared-secret',
        RATE_LIMIT_ENABLED: undefined,
        RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();
        expect(config.authEnabled).toBe(true);
        expect(config.rateLimitEnabled).toBe(true);
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

describe('ricardian tenant delegation config', () => {
  const API_KEYS = JSON.stringify([
    { id: 'cotsel-gateway', secret: 'gateway-secret', active: true },
    { id: 'other-service', secret: 'other-secret', active: true },
  ]);

  test('delegates to no caller unless a deployment names one', () => {
    withEnv({ API_KEYS_JSON: API_KEYS, TENANT_DELEGATION_API_KEYS: undefined }, () => {
      expect(loadConfigModule().loadConfig().tenantDelegationApiKeys).toEqual([]);
    });
  });

  test('accepts a delegating caller that is a configured API key', () => {
    withEnv({ API_KEYS_JSON: API_KEYS, TENANT_DELEGATION_API_KEYS: ' cotsel-gateway ' }, () => {
      expect(loadConfigModule().loadConfig().tenantDelegationApiKeys).toEqual(['cotsel-gateway']);
    });
  });

  test('rejects a delegating caller Ricardian cannot authenticate', () => {
    withEnv({ API_KEYS_JSON: API_KEYS, TENANT_DELEGATION_API_KEYS: 'unknown-caller' }, () => {
      expect(() => loadConfigModule()).toThrow(
        'TENANT_DELEGATION_API_KEYS names unknown-caller, which is not a configured API key',
      );
    });
  });
});
