'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionOptions,
  resolveMigrationCredentials,
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
