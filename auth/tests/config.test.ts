import path from 'path';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3005',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'agroasys_auth',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_MIGRATION_USER: '',
  DB_MIGRATION_PASSWORD: '',
  SESSION_TTL_SECONDS: '3600',
  LEGACY_WALLET_LOGIN_ENABLED: 'true',
};

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
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
    run();
  } finally {
    process.env = snapshot;
  }
}

function loadConfigModule(): typeof import('../src/config') {
  const modulePath = path.resolve(__dirname, '../src/config');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath) as typeof import('../src/config');
}

describe('auth config', () => {
  test('production disables the legacy wallet login path by default', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        LEGACY_WALLET_LOGIN_ENABLED: undefined,
      },
      () => {
        const { loadConfig } = loadConfigModule();
        const config = loadConfig();
        expect(config.legacyWalletLoginEnabled).toBe(false);
      },
    );
  });

  test('non-development environments reject explicit legacy wallet login enablement', () => {
    withEnv(
      {
        NODE_ENV: 'staging',
        LEGACY_WALLET_LOGIN_ENABLED: 'true',
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow(
          'LEGACY_WALLET_LOGIN_ENABLED=true is allowed only when NODE_ENV is development or test',
        );
      },
    );
  });

  test('browser no-origin CORS is disabled by default', () => {
    withEnv({}, () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();
      expect(config.corsAllowNoOrigin).toBe(false);
    });
  });

  test('migration credentials must be configured as a pair', () => {
    withEnv(
      {
        DB_MIGRATION_USER: 'auth_migrator',
        DB_MIGRATION_PASSWORD: undefined,
      },
      () => {
        const { loadConfig } = loadConfigModule();
        expect(() => loadConfig()).toThrow('DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together');
      },
    );
  });
});
