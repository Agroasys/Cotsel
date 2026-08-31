'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadMigrationManifest, runVersionedMigrations, sha256 } = require('./migrate');

function createManifest(sql = 'CREATE TABLE example (id INTEGER PRIMARY KEY);') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-migration-'));
  const migrationPath = path.join(directory, '001.sql');
  const manifestPath = path.join(directory, 'migrations.json');
  fs.writeFileSync(migrationPath, sql);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      migrations: [
        {
          version: '202608310001',
          name: 'baseline',
          file: '001.sql',
          sha256: sha256(sql),
          baseline: true,
        },
      ],
    }),
  );
  return { directory, manifestPath, migrationPath };
}

function createPool({ appliedRows = [], failSql = false, hasExistingTables = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM cotsel_schema_migrations')) {
        return { rows: appliedRows };
      }
      if (sql.includes('FROM pg_catalog.pg_tables')) {
        return { rows: hasExistingTables ? [{ '?column?': 1 }] : [] };
      }
      if (failSql && sql.startsWith('CREATE TABLE example')) {
        throw new Error('injected migration failure');
      }
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

test('migration manifest rejects modified SQL', (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fs.appendFileSync(fixture.migrationPath, '\nSELECT 1;\n');

  assert.throws(
    () => loadMigrationManifest(fixture.manifestPath),
    /checksum does not match its manifest/,
  );
});

test('versioned runner locks, applies transactionally, and records the checksum', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { calls, pool } = createPool();

  const result = await runVersionedMigrations({
    pool,
    serviceName: 'gateway',
    manifestPath: fixture.manifestPath,
  });

  assert.equal(result.declared, 1);
  assert.equal(result.applied.length, 1);
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_lock')));
  assert.ok(calls.some(({ sql }) => sql === 'BEGIN'));
  assert.ok(calls.some(({ sql }) => sql === 'COMMIT'));
  const ledgerInsert = calls.find(({ sql }) =>
    sql.includes('INSERT INTO cotsel_schema_migrations'),
  );
  assert.deepEqual(ledgerInsert.parameters.slice(0, 4), [
    'gateway',
    '202608310001',
    'baseline',
    sha256('CREATE TABLE example (id INTEGER PRIMARY KEY);'),
  ]);
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('versioned runner skips an identical applied migration', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const checksum = sha256('CREATE TABLE example (id INTEGER PRIMARY KEY);');
  const { calls, pool } = createPool({
    appliedRows: [{ version: '202608310001', name: 'baseline', checksum }],
  });

  const result = await runVersionedMigrations({
    pool,
    serviceName: 'gateway',
    manifestPath: fixture.manifestPath,
  });

  assert.equal(result.applied.length, 0);
  assert.ok(!calls.some(({ sql }) => sql === 'BEGIN'));
});

test('versioned runner rolls back a partial failure without recording it', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { calls, pool } = createPool({ failSql: true });

  await assert.rejects(
    runVersionedMigrations({
      pool,
      serviceName: 'gateway',
      manifestPath: fixture.manifestPath,
    }),
    /injected migration failure/,
  );

  assert.ok(calls.some(({ sql }) => sql === 'ROLLBACK'));
  assert.ok(!calls.some(({ sql }) => sql.includes('INSERT INTO cotsel_schema_migrations')));
  assert.ok(!calls.some(({ sql }) => sql === 'COMMIT'));
});

test('versioned runner rejects ledger drift before executing DDL', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { calls, pool } = createPool({
    appliedRows: [{ version: '202608310001', name: 'baseline', checksum: '0'.repeat(64) }],
  });

  await assert.rejects(
    runVersionedMigrations({
      pool,
      serviceName: 'gateway',
      manifestPath: fixture.manifestPath,
    }),
    /does not match the immutable manifest/,
  );

  assert.ok(!calls.some(({ sql }) => sql === 'BEGIN'));
});

test('baseline migration refuses a populated schema before executing DDL', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { calls, pool } = createPool({ hasExistingTables: true });

  await assert.rejects(
    runVersionedMigrations({
      pool,
      serviceName: 'gateway',
      manifestPath: fixture.manifestPath,
    }),
    /requires an empty public schema/,
  );

  assert.ok(!calls.some(({ sql }) => sql === 'BEGIN'));
  assert.ok(!calls.some(({ sql }) => sql.includes('INSERT INTO cotsel_schema_migrations')));
});
