'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionOptions, parsePostgresSslMode, resolvePostgresSslConfig } = require('./index');

test('parsePostgresSslMode accepts supported modes and rejects ambiguous values', () => {
  assert.equal(parsePostgresSslMode(undefined), 'disable');
  assert.equal(parsePostgresSslMode(' require '), 'require');
  assert.equal(parsePostgresSslMode('verify-full'), 'verify-full');
  assert.throws(
    () => parsePostgresSslMode('no-verify'),
    /DB_SSL_MODE must be one of disable, require, or verify-full/,
  );
});

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
