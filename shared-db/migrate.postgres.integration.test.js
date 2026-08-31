'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { assertMigrationHistory, runVersionedMigrations, sha256 } = require('./migrate');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('./postgres-test-support');

function createMigrationFixture(sql, version, baseline = false) {
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
          baseline,
        },
      ],
    }),
  );
  return { directory, manifestPath: path.join(directory, 'migrations.json') };
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
      const concurrentFixture = createMigrationFixture(
        'SELECT pg_sleep(0.5); CREATE TABLE concurrent_migration_proof (id INTEGER PRIMARY KEY);',
        '202608310010',
      );
      const failureFixture = createMigrationFixture(
        'CREATE TABLE partial_migration_must_rollback (id INTEGER); SELECT missing_function();',
        '202608310011',
      );
      const baselineFixture = createMigrationFixture(
        'CREATE TABLE baseline_migration_proof (id INTEGER PRIMARY KEY);',
        '202608310001',
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
