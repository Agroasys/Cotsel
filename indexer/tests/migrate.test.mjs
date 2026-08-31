import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  loadIndexerMigrationManifest,
  main,
  runLockedIndexerMigration,
  validateIndexerHistory,
} = require('../migrate');

const declaredMigration = {
  version: '1771180205323',
  typeormName: 'Data1771180205323',
  checksum: 'a'.repeat(64),
};

function createPool({ tableExists = false, checksumColumn = false, rows = [] } = {}) {
  const calls = [];
  const state = { tableExists, checksumColumn, rows: rows.map((row) => ({ ...row })) };
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("to_regclass('public.migrations')")) {
        return { rows: [{ migration_table: state.tableExists ? 'migrations' : null }] };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ checksum_column: state.checksumColumn }] };
      }
      if (sql.includes('FROM public.migrations ORDER BY id')) {
        return { rows: state.rows.map((row) => ({ ...row })) };
      }
      if (sql.includes('ALTER TABLE public.migrations ADD COLUMN')) {
        state.tableExists = true;
        state.checksumColumn = true;
      }
      if (sql.includes('UPDATE public.migrations')) {
        const [checksum, timestamp, name] = parameters;
        const row = state.rows.find(
          (candidate) => candidate.timestamp === String(timestamp) && candidate.name === name,
        );
        if (row && !row.checksum) {
          row.checksum = checksum;
        }
      }
      return { rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE' });
    },
  };
  return {
    calls,
    state,
    pool: {
      async connect() {
        return client;
      },
    },
  };
}

test('indexer migration wrapper holds a Postgres advisory lock around the migration command', async () => {
  const { calls, pool, state } = createPool();
  const commandCalls = [];

  await runLockedIndexerMigration({
    pool,
    command: '/app/indexer/node_modules/.bin/squid-typeorm-migration',
    args: ['apply'],
    commandOptions: { cwd: '/app/indexer' },
    migrations: [declaredMigration],
    execute: async (...args) => {
      commandCalls.push(args);
      state.tableExists = true;
      state.rows.push({
        timestamp: declaredMigration.version,
        name: declaredMigration.typeormName,
        checksum: null,
      });
    },
  });

  assert.equal(commandCalls.length, 1);
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_lock')));
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_unlock')));
  assert.equal(state.rows[0].checksum, declaredMigration.checksum);
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
      migrations: [declaredMigration],
      execute: async () => {
        throw new Error('injected command failure');
      },
    }),
    /injected command failure/,
  );

  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_unlock')));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('indexer migration wrapper refuses implicit adoption of unchecksummed history', async () => {
  const { pool } = createPool({
    tableExists: true,
    rows: [
      {
        timestamp: declaredMigration.version,
        name: declaredMigration.typeormName,
        checksum: null,
      },
    ],
  });
  let executed = false;

  await assert.rejects(
    runLockedIndexerMigration({
      pool,
      command: 'migration-command',
      args: ['apply'],
      commandOptions: {},
      migrations: [declaredMigration],
      execute: async () => {
        executed = true;
      },
    }),
    /no durable checksum; stop and create a reviewed adoption design/,
  );
  assert.equal(executed, false);
});

test('indexer history rejects checksum drift', () => {
  assert.throws(
    () =>
      validateIndexerHistory([declaredMigration], {
        checksumColumn: true,
        rows: [
          {
            timestamp: declaredMigration.version,
            name: declaredMigration.typeormName,
            checksum: 'b'.repeat(64),
          },
        ],
      }),
    /does not match the immutable manifest/,
  );
});

test('indexer history rejects an applied migration that skips an earlier manifest entry', () => {
  const earlierMigration = {
    version: '1771180205322',
    typeormName: 'Earlier1771180205322',
    checksum: 'c'.repeat(64),
  };

  assert.throws(
    () =>
      validateIndexerHistory([earlierMigration, declaredMigration], {
        checksumColumn: true,
        rows: [
          {
            timestamp: declaredMigration.version,
            name: declaredMigration.typeormName,
            checksum: declaredMigration.checksum,
          },
        ],
      }),
    /history is not an ordered manifest prefix/,
  );
});

test('indexer manifest binds every checksum to its TypeORM timestamp and class name', () => {
  const migrations = loadIndexerMigrationManifest(
    fileURLToPath(new URL('../db/migrations.json', import.meta.url)),
  );
  assert.equal(migrations.length, 17);
  for (const migration of migrations) {
    assert.equal(migration.typeormName.slice(-13), migration.version);
  }
});

test('indexer migration entrypoint rejects unsupported schema selection', async () => {
  const priorSchema = process.env.DB_SCHEMA;
  process.env.DB_SCHEMA = 'unreviewed_schema';
  try {
    await assert.rejects(main(), /DB_SCHEMA must be public/);
  } finally {
    if (priorSchema === undefined) {
      delete process.env.DB_SCHEMA;
    } else {
      process.env.DB_SCHEMA = priorSchema;
    }
  }
});
