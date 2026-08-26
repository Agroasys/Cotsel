'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');

const { runVersionedMigrations } = require('./migrationRunner');

const POSTGRES_IMAGE = process.env.SHARED_DB_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const CONTAINER_NAME = `cotsel-migration-runner-${process.pid}-${Date.now()}`;
const MIGRATION_USER = 'migration_runner';
const RUNTIME_USER = 'application_runtime';
const BASELINE_SERVICES = ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury'];
let dockerAvailable = true;
let port;

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

try {
  docker(['version']);
} catch {
  dockerAvailable = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function migrationDirectory(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-pg-migrations-'));
  for (const [filename, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, filename), sql);
  }
  return directory;
}

function pool(database, user = MIGRATION_USER, password = 'migration-pass') {
  return new Pool({ host: '127.0.0.1', port, database, user, password, max: 2 });
}

async function createDatabase(name) {
  const admin = new Pool({
    host: '127.0.0.1',
    port,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
  });
  try {
    await admin.query(`CREATE DATABASE "${name}" OWNER ${MIGRATION_USER}`);
  } finally {
    await admin.end();
  }
}

async function query(database, sql, values = [], user, password) {
  const connection = pool(database, user, password);
  try {
    return await connection.query(sql, values);
  } finally {
    await connection.end();
  }
}

async function preparePostgres() {
  if (!dockerAvailable) {
    return;
  }

  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    CONTAINER_NAME,
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);
  port = Number.parseInt(docker(['port', CONTAINER_NAME, '5432/tcp']).split(':').pop(), 10);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await query('postgres', 'SELECT 1', [], 'postgres', 'postgres');
      break;
    } catch (error) {
      if (attempt === 59) throw error;
      await sleep(500);
    }
  }

  const admin = new Pool({
    host: '127.0.0.1',
    port,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
  });
  try {
    await admin.query(
      `CREATE ROLE ${MIGRATION_USER} LOGIN PASSWORD 'migration-pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await admin.query(
      `CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD 'runtime-pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
  } finally {
    await admin.end();
  }
}

test.before(async () => preparePostgres());
test.after(() => {
  if (dockerAvailable) {
    try {
      docker(['rm', '-f', CONTAINER_NAME], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // The test result is authoritative even if best-effort container cleanup fails.
    }
  }
});

test(
  'migration ledger is idempotent, content-bound, and hidden from the runtime role',
  { skip: !dockerAvailable, timeout: 120000 },
  async () => {
    const database = 'migration_ledger_test';
    const directory = migrationDirectory({
      '0001_baseline.sql': `
        CREATE TABLE records (id BIGINT PRIMARY KEY, value TEXT NOT NULL);
        GRANT SELECT, INSERT, UPDATE, DELETE ON records TO ${RUNTIME_USER};
      `,
    });
    await createDatabase(database);
    await query(database, `GRANT CONNECT ON DATABASE ${database} TO ${RUNTIME_USER}`);
    const migrationPool = pool(database);

    try {
      const first = await runVersionedMigrations(migrationPool, {
        serviceName: 'ledger-test',
        directory,
        runtimeDbUser: RUNTIME_USER,
      });
      const second = await runVersionedMigrations(migrationPool, {
        serviceName: 'ledger-test',
        directory,
        runtimeDbUser: RUNTIME_USER,
      });
      assert.equal(first.applied.length, 1);
      assert.equal(second.applied.length, 0);
      assert.equal(
        Number(
          (await query(database, 'SELECT count(*) FROM cotsel_schema_migrations')).rows[0].count,
        ),
        1,
      );
      await assert.rejects(
        () =>
          query(
            database,
            'SELECT * FROM cotsel_schema_migrations',
            [],
            RUNTIME_USER,
            'runtime-pass',
          ),
        /permission denied/i,
      );

      fs.appendFileSync(path.join(directory, '0001_baseline.sql'), '\nSELECT 1;\n');
      await assert.rejects(
        () =>
          runVersionedMigrations(migrationPool, {
            serviceName: 'ledger-test',
            directory,
            runtimeDbUser: RUNTIME_USER,
          }),
        /Checksum mismatch/,
      );
    } finally {
      await migrationPool.end();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'concurrent migration jobs serialize and apply each migration once',
  { skip: !dockerAvailable, timeout: 120000 },
  async () => {
    const database = 'migration_concurrency_test';
    const directory = migrationDirectory({
      '0001_baseline.sql': `
        CREATE TABLE apply_probe (id INTEGER PRIMARY KEY);
        INSERT INTO apply_probe (id) VALUES (1);
        SELECT pg_sleep(0.5);
      `,
    });
    await createDatabase(database);
    const firstPool = pool(database);
    const secondPool = pool(database);

    try {
      const results = await Promise.all([
        runVersionedMigrations(firstPool, {
          serviceName: 'concurrency-test',
          directory,
          runtimeDbUser: RUNTIME_USER,
        }),
        runVersionedMigrations(secondPool, {
          serviceName: 'concurrency-test',
          directory,
          runtimeDbUser: RUNTIME_USER,
        }),
      ]);
      assert.deepEqual(results.map((result) => result.applied.length).sort(), [0, 1]);
      assert.equal(
        Number((await query(database, 'SELECT count(*) FROM apply_probe')).rows[0].count),
        1,
      );
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'failed migration rolls back schema changes and ledger identity',
  { skip: !dockerAvailable, timeout: 120000 },
  async () => {
    const database = 'migration_rollback_test';
    const directory = migrationDirectory({
      '0001_broken.sql': 'CREATE TABLE must_rollback (id INTEGER); SELECT missing_column;',
    });
    await createDatabase(database);
    const migrationPool = pool(database);

    try {
      await assert.rejects(
        () =>
          runVersionedMigrations(migrationPool, {
            serviceName: 'rollback-test',
            directory,
            runtimeDbUser: RUNTIME_USER,
          }),
        /missing_column/,
      );
      const relation = await query(database, "SELECT to_regclass('public.must_rollback') AS name");
      assert.equal(relation.rows[0].name, null);
      const ledger = await query(
        database,
        "SELECT count(*) FROM cotsel_schema_migrations WHERE service_name = 'rollback-test'",
      );
      assert.equal(Number(ledger.rows[0].count), 0);
    } finally {
      await migrationPool.end();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'every service baseline is safe to adopt once and then remains idempotent',
  { skip: !dockerAvailable, timeout: 120000 },
  async () => {
    for (const serviceName of BASELINE_SERVICES) {
      const database = `baseline_${serviceName}`;
      const directory = path.resolve(__dirname, `../${serviceName}/src/database/migrations`);
      await createDatabase(database);
      await query(database, `GRANT CONNECT ON DATABASE ${database} TO ${RUNTIME_USER}`);
      const migrationPool = pool(database);

      try {
        const first = await runVersionedMigrations(migrationPool, {
          serviceName,
          directory,
          runtimeDbUser: RUNTIME_USER,
        });
        const second = await runVersionedMigrations(migrationPool, {
          serviceName,
          directory,
          runtimeDbUser: RUNTIME_USER,
        });
        assert.equal(first.applied.length, 1, `${serviceName} baseline must apply once`);
        assert.equal(second.applied.length, 0, `${serviceName} baseline must not reapply`);
        assert.equal(first.current[0].id, '0001_baseline');
      } finally {
        await migrationPool.end();
      }
    }
  },
);
