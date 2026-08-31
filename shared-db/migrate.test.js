'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertMigrationHistory,
  loadMigrationManifest,
  quotePostgresIdentifier,
  runVersionedMigrations,
  sha256,
} = require('./migrate');

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

function createPool({
  appliedRows = [],
  failSql = false,
  existingObject,
  ledgerExists = false,
} = {}) {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM cotsel_schema_migrations')) {
        return { rows: appliedRows };
      }
      if (sql.includes("to_regclass('public.cotsel_schema_migrations')")) {
        return { rows: [{ ledger: ledgerExists ? 'cotsel_schema_migrations' : null }] };
      }
      if (sql.includes('WITH application_objects')) {
        return { rows: existingObject ? [existingObject] : [] };
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
      async query(sql, parameters) {
        return client.query(sql, parameters);
      },
    },
  };
}

test('PostgreSQL role identifiers are validated before interpolation', () => {
  assert.equal(
    quotePostgresIdentifier('cotsel_gateway_runtime', 'DB_RUNTIME_USER'),
    '"cotsel_gateway_runtime"',
  );
  assert.throws(
    () => quotePostgresIdentifier('runtime; DROP ROLE postgres', 'DB_RUNTIME_USER'),
    /lowercase PostgreSQL identifier/,
  );
  assert.throws(
    () => quotePostgresIdentifier(undefined, 'DB_RUNTIME_USER'),
    /lowercase PostgreSQL identifier/,
  );
});

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
    runtimeDbUser: 'cotsel_gateway_runtime',
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
    runtimeDbUser: 'cotsel_gateway_runtime',
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
      runtimeDbUser: 'cotsel_gateway_runtime',
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
      runtimeDbUser: 'cotsel_gateway_runtime',
    }),
    /does not match the immutable manifest/,
  );

  assert.ok(!calls.some(({ sql }) => sql === 'BEGIN'));
});

test('versioned runner rejects a non-prefix applied history before executing DDL', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  const laterVersion = '202608310002';
  const laterSql = 'CREATE TABLE later_example (id INTEGER PRIMARY KEY);';
  fs.writeFileSync(path.join(fixture.directory, `${laterVersion}.sql`), laterSql);
  manifest.migrations.push({
    version: laterVersion,
    name: 'later_example',
    file: `${laterVersion}.sql`,
    sha256: sha256(laterSql),
  });
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest));

  const { calls, pool } = createPool({
    appliedRows: [
      {
        version: laterVersion,
        name: 'later_example',
        checksum: sha256(laterSql),
      },
    ],
    ledgerExists: true,
  });

  await assert.rejects(
    runVersionedMigrations({
      pool,
      serviceName: 'gateway',
      manifestPath: fixture.manifestPath,
      runtimeDbUser: 'cotsel_gateway_runtime',
    }),
    /history is not an ordered manifest prefix/,
  );

  assert.ok(!calls.some(({ sql }) => sql === 'BEGIN'));
});

test('baseline migration refuses any application object before creating its ledger', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { calls, pool } = createPool({
    existingObject: { object_type: 'function', object_name: 'legacy_writer' },
  });

  await assert.rejects(
    runVersionedMigrations({
      pool,
      serviceName: 'gateway',
      manifestPath: fixture.manifestPath,
      runtimeDbUser: 'cotsel_gateway_runtime',
    }),
    /requires an empty public schema/,
  );

  assert.ok(!calls.some(({ sql }) => sql === 'BEGIN'));
  assert.ok(
    !calls.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS cotsel_schema_migrations')),
  );
  assert.ok(!calls.some(({ sql }) => sql.includes('INSERT INTO cotsel_schema_migrations')));
});

test('runtime history check rejects a missing ledger', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { pool } = createPool();

  await assert.rejects(
    assertMigrationHistory({
      pool,
      serviceName: 'gateway',
      manifestPath: fixture.manifestPath,
    }),
    /schema migration ledger is missing/,
  );
});

test('runtime history check rejects a pending migration', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { pool } = createPool({ ledgerExists: true });

  await assert.rejects(
    assertMigrationHistory({
      pool,
      serviceName: 'gateway',
      manifestPath: fixture.manifestPath,
    }),
    /schema is not current/,
  );
});

test('runtime history check accepts the exact immutable manifest', async (t) => {
  const fixture = createManifest();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const checksum = sha256('CREATE TABLE example (id INTEGER PRIMARY KEY);');
  const { pool } = createPool({
    ledgerExists: true,
    appliedRows: [{ version: '202608310001', name: 'baseline', checksum }],
  });

  await assertMigrationHistory({
    pool,
    serviceName: 'gateway',
    manifestPath: fixture.manifestPath,
  });
});
