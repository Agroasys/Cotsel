'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runVersionedMigrations, sha256 } = require('./migrate');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('./postgres-test-support');

function createMigrationFixture(sql, version) {
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
      const concurrentFixture = createMigrationFixture(
        'SELECT pg_sleep(0.5); CREATE TABLE concurrent_migration_proof (id INTEGER PRIMARY KEY);',
        '202608310010',
      );
      const failureFixture = createMigrationFixture(
        'CREATE TABLE partial_migration_must_rollback (id INTEGER); SELECT missing_function();',
        '202608310011',
      );

      try {
        const results = await Promise.all([
          runVersionedMigrations({
            pool: firstPool,
            serviceName: 'concurrency-test',
            manifestPath: concurrentFixture.manifestPath,
          }),
          runVersionedMigrations({
            pool: secondPool,
            serviceName: 'concurrency-test',
            manifestPath: concurrentFixture.manifestPath,
          }),
        ]);
        assert.equal(results[0].applied.length + results[1].applied.length, 1);

        const ledger = await firstPool.query(
          `SELECT COUNT(*)::integer AS count
           FROM cotsel_schema_migrations
           WHERE service_name = 'concurrency-test'`,
        );
        assert.equal(ledger.rows[0].count, 1);

        await assert.rejects(
          runVersionedMigrations({
            pool: firstPool,
            serviceName: 'partial-failure-test',
            manifestPath: failureFixture.manifestPath,
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
        await firstPool.end();
        await secondPool.end();
        fs.rmSync(concurrentFixture.directory, { recursive: true, force: true });
        fs.rmSync(failureFixture.directory, { recursive: true, force: true });
      }
    });
  },
);
