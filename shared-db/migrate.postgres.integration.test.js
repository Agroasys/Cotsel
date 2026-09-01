'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { assertMigrationHistory, runVersionedMigrations, sha256 } = require('./migrate');
const { computePublicSchemaFingerprint } = require('./schema-fingerprint');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('./postgres-test-support');

function createMigrationFixture(
  sql,
  version,
  schemaChecksum,
  baseline = false,
  adoptExistingSchema = false,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-postgres-migration-'));
  const migrationFile = `${version}.sql`;
  fs.writeFileSync(path.join(directory, migrationFile), sql);
  fs.writeFileSync(
    path.join(directory, 'migrations.json'),
    JSON.stringify({
      migrations: [
        {
          version,
          name: 'integration_test',
          file: migrationFile,
          sha256: sha256(sql),
          schema_sha256: schemaChecksum,
          baseline,
          adopt_existing_schema: adoptExistingSchema,
        },
      ],
    }),
  );
  return { directory, manifestPath: path.join(directory, 'migrations.json') };
}

async function fingerprintAfterSql(pool, sql) {
  await pool.query('BEGIN');
  try {
    await pool.query(sql);
    return await computePublicSchemaFingerprint(pool);
  } finally {
    await pool.query('ROLLBACK');
  }
}

test(
  'migration lock permits one owner and partial failure leaves no schema or ledger residue',
  { timeout: 120000, skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ port }) => {
      const firstPool = await createAdminPool(port);
      const secondPool = await createAdminPool(port);
      await firstPool.query(`CREATE ROLE cotsel_test_runtime LOGIN PASSWORD 'runtime-password'`);
      const runtimePool = new Pool({
        host: '127.0.0.1',
        port,
        database: 'postgres',
        user: 'cotsel_test_runtime',
        password: 'runtime-password',
      });
      const concurrentSql =
        'SELECT pg_sleep(0.5); CREATE TABLE concurrent_migration_proof (id INTEGER PRIMARY KEY);';
      const failureSql =
        'CREATE TABLE partial_migration_must_rollback (id INTEGER); SELECT missing_function();';
      const baselineSql = 'CREATE TABLE baseline_migration_proof (id INTEGER PRIMARY KEY);';
      const concurrentFixture = createMigrationFixture(
        concurrentSql,
        '202608310010',
        await fingerprintAfterSql(firstPool, concurrentSql),
      );
      const failureFixture = createMigrationFixture(failureSql, '202608310011', '0'.repeat(64));
      const baselineFixture = createMigrationFixture(
        baselineSql,
        '202608310001',
        await fingerprintAfterSql(firstPool, baselineSql),
        true,
      );

      try {
        await firstPool.query('CREATE VIEW legacy_application_view AS SELECT 1 AS value');
        await assert.rejects(
          runVersionedMigrations({
            pool: firstPool,
            serviceName: 'baseline-test',
            manifestPath: baselineFixture.manifestPath,
            runtimeDbUser: 'cotsel_test_runtime',
          }),
          /found relation legacy_application_view/,
        );
        const baselineResidue = await firstPool.query(
          `SELECT to_regclass('public.cotsel_schema_migrations') AS ledger`,
        );
        assert.equal(baselineResidue.rows[0].ledger, null);
        await firstPool.query('DROP VIEW legacy_application_view');

        const results = await Promise.all([
          runVersionedMigrations({
            pool: firstPool,
            serviceName: 'concurrency-test',
            manifestPath: concurrentFixture.manifestPath,
            runtimeDbUser: 'cotsel_test_runtime',
          }),
          runVersionedMigrations({
            pool: secondPool,
            serviceName: 'concurrency-test',
            manifestPath: concurrentFixture.manifestPath,
            runtimeDbUser: 'cotsel_test_runtime',
          }),
        ]);
        assert.equal(results[0].applied.length + results[1].applied.length, 1);

        const ledger = await firstPool.query(
          `SELECT COUNT(*)::integer AS count
           FROM cotsel_schema_migrations
           WHERE service_name = 'concurrency-test'`,
        );
        assert.equal(ledger.rows[0].count, 1);
        await assertMigrationHistory({
          pool: runtimePool,
          serviceName: 'concurrency-test',
          manifestPath: concurrentFixture.manifestPath,
        });

        await assert.rejects(
          runVersionedMigrations({
            pool: firstPool,
            serviceName: 'partial-failure-test',
            manifestPath: failureFixture.manifestPath,
            runtimeDbUser: 'cotsel_test_runtime',
          }),
          /missing_function/,
        );
        const residue = await firstPool.query(
          `SELECT
             to_regclass('public.partial_migration_must_rollback') AS relation,
             (SELECT COUNT(*)::integer
              FROM cotsel_schema_migrations
              WHERE service_name = 'partial-failure-test') AS ledger_count`,
        );
        assert.equal(residue.rows[0].relation, null);
        assert.equal(residue.rows[0].ledger_count, 0);
      } finally {
        await runtimePool.end();
        await firstPool.end();
        await secondPool.end();
        fs.rmSync(concurrentFixture.directory, { recursive: true, force: true });
        fs.rmSync(failureFixture.directory, { recursive: true, force: true });
        fs.rmSync(baselineFixture.directory, { recursive: true, force: true });
      }
    });
  },
);

test(
  'baseline adoption preserves an equivalent populated schema and rejects drift first',
  { timeout: 120000, skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ port }) => {
      const pool = await createAdminPool(port);
      await pool.query(`CREATE ROLE cotsel_adoption_runtime NOLOGIN`);
      const baselineSql =
        'CREATE TABLE adoption_proof (id BIGINT PRIMARY KEY, value TEXT NOT NULL);';
      const expectedFingerprint = await fingerprintAfterSql(pool, baselineSql);
      const fixture = createMigrationFixture(
        baselineSql,
        '202608310001',
        expectedFingerprint,
        true,
        true,
      );

      try {
        await pool.query(baselineSql);
        await pool.query(`INSERT INTO adoption_proof (id, value) VALUES (1, 'preserved')`);
        const relationBefore = await pool.query(
          `SELECT 'public.adoption_proof'::regclass::oid AS oid`,
        );
        await pool.query('CREATE TABLE unexpected_drift (id BIGINT PRIMARY KEY)');

        await assert.rejects(
          runVersionedMigrations({
            pool,
            serviceName: 'adoption-test',
            manifestPath: fixture.manifestPath,
            runtimeDbUser: 'cotsel_adoption_runtime',
          }),
          /does not match the adoption fingerprint/,
        );
        const rejectedLedger = await pool.query(
          `SELECT to_regclass('public.cotsel_schema_migrations') AS ledger`,
        );
        assert.equal(rejectedLedger.rows[0].ledger, null);

        await pool.query('DROP TABLE unexpected_drift');
        const result = await runVersionedMigrations({
          pool,
          serviceName: 'adoption-test',
          manifestPath: fixture.manifestPath,
          runtimeDbUser: 'cotsel_adoption_runtime',
        });
        assert.equal(result.applied[0].applicationMode, 'adopted');

        const proof = await pool.query(`
          SELECT
            'public.adoption_proof'::regclass::oid AS oid,
            (SELECT value FROM adoption_proof WHERE id = 1) AS value,
            migration.application_mode,
            trim(migration.schema_checksum) AS schema_checksum
          FROM cotsel_schema_migrations migration
          WHERE migration.service_name = 'adoption-test'
        `);
        assert.equal(proof.rows[0].oid, relationBefore.rows[0].oid);
        assert.equal(proof.rows[0].value, 'preserved');
        assert.equal(proof.rows[0].application_mode, 'adopted');
        assert.equal(proof.rows[0].schema_checksum, expectedFingerprint);
      } finally {
        await pool.end();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
      }
    });
  },
);
