import path from 'path';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3005',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'agroasys_auth',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL_MODE: 'disable',
  SESSION_TTL_SECONDS: '3600',
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
  jest.resetModules();
  let loaded!: typeof import('../src/config');
  jest.isolateModules(() => {
    loaded = jest.requireActual(modulePath) as typeof import('../src/config');
  });
  return loaded;
}

describe('auth config', () => {
  test('browser no-origin CORS is disabled by default', () => {
    withEnv({}, () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();
      expect(config.corsAllowNoOrigin).toBe(false);
    });
  });

  test('Postgres SSL mode is explicit and validated', () => {
    withEnv({ DB_SSL_MODE: 'require' }, () => {
      const { loadConfig } = loadConfigModule();
      expect(loadConfig().dbSslMode).toBe('require');
    });

    withEnv({ DB_SSL_MODE: 'no-verify' }, () => {
      const { loadConfig } = loadConfigModule();
      expect(() => loadConfig()).toThrow(
        'DB_SSL_MODE must be one of disable, require, or verify-full',
      );
    });
  });
});
