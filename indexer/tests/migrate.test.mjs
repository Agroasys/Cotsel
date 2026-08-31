import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runLockedIndexerMigration } = require('../migrate');

function createPool() {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE' });
    },
  };
  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
    },
  };
}

test('indexer migration wrapper holds a Postgres advisory lock around the migration command', async () => {
  const { calls, pool } = createPool();
  const commandCalls = [];

  await runLockedIndexerMigration({
    pool,
    command: '/app/indexer/node_modules/.bin/squid-typeorm-migration',
    args: ['apply'],
    commandOptions: { cwd: '/app/indexer' },
    execute: async (...args) => commandCalls.push(args),
  });

  assert.equal(commandCalls.length, 1);
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_lock')));
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_unlock')));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('indexer migration wrapper releases the lock after command failure', async () => {
  const { calls, pool } = createPool();

  await assert.rejects(
    runLockedIndexerMigration({
      pool,
      command: 'migration-command',
      args: ['apply'],
      commandOptions: {},
      execute: async () => {
        throw new Error('injected command failure');
      },
    }),
    /injected command failure/,
  );

  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_unlock')));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});
