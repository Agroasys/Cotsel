'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionOptions,
  createServicePool,
  resolveMigrationCredentials,
  resolvePostgresSslConfig,
} = require('./index');

test('buildSessionOptions pins service session settings', () => {
  const options = buildSessionOptions({
    serviceName: 'gateway',
    connectionRole: 'runtime',
    runtimeDbUser: 'cotsel_gateway_app',
  });

  assert.match(options, /app\.service_name=gateway/);
  assert.match(options, /app\.connection_role=runtime/);
  assert.match(options, /app\.runtime_db_user=cotsel_gateway_app/);
});

test('resolveMigrationCredentials prefers dedicated migration credentials when present', () => {
  assert.deepEqual(
    resolveMigrationCredentials({
      dbUser: 'app_user',
      dbPassword: 'app_pass',
      dbMigrationUser: 'migration_user',
      dbMigrationPassword: 'migration_pass',
    }),
    {
      user: 'migration_user',
      password: 'migration_pass',
    },
  );
});

test('resolveMigrationCredentials falls back to runtime credentials when migration credentials are absent', () => {
  assert.deepEqual(
    resolveMigrationCredentials({
      dbUser: 'app_user',
      dbPassword: 'app_pass',
    }),
    {
      user: 'app_user',
      password: 'app_pass',
    },
  );
});

test('resolvePostgresSslConfig disables SSL by default', () => {
  assert.equal(resolvePostgresSslConfig(), false);
  assert.equal(resolvePostgresSslConfig('disable'), false);
});

test('resolvePostgresSslConfig supports encrypted RDS connections', () => {
  assert.deepEqual(resolvePostgresSslConfig('require'), { rejectUnauthorized: false });
  assert.deepEqual(resolvePostgresSslConfig('verify-full'), { rejectUnauthorized: true });
});

test('resolvePostgresSslConfig rejects unknown modes', () => {
  assert.throws(() => resolvePostgresSslConfig('prefer'), /Unsupported Postgres SSL mode/);
});

test('createServicePool honors DB_SSL_MODE when sslMode is not passed', async () => {
  const previousDbSslMode = process.env.DB_SSL_MODE;
  const previousPgSslMode = process.env.PGSSLMODE;
  process.env.DB_SSL_MODE = 'require';
  delete process.env.PGSSLMODE;

  const pool = createServicePool({
    serviceName: 'gateway',
    host: 'localhost',
    port: 5432,
    database: 'cotsel',
    user: 'runtime_user',
    password: 'runtime_password',
  });

  try {
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: false });
  } finally {
    await pool.end();

    if (previousDbSslMode === undefined) {
      delete process.env.DB_SSL_MODE;
    } else {
      process.env.DB_SSL_MODE = previousDbSslMode;
    }

    if (previousPgSslMode === undefined) {
      delete process.env.PGSSLMODE;
    } else {
      process.env.PGSSLMODE = previousPgSslMode;
    }
  }
});
