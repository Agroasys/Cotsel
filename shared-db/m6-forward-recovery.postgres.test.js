'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { assertMigrationHistory, runVersionedMigrations } = require('./migrate');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('./postgres-test-support');

// A database compatibility rehearsal, not an image or staging rollback claim.
// Keep the immutable ledger intact: an old manifest must fail, the exact forward
// manifest must pass idempotently, and evidence/approval tables must survive.
for (const [service, directory, oldHead, protectedTable] of [
  ['auth', 'auth/src/database', '202609010005', 'user_sessions'],
  ['gateway', 'gateway/src/database', '202610180016', 'settlement_templates'],
  ['reconciliation', 'reconciliation/src/database', '202611230002', 'reconcile_run_manifests'],
]) {
  test(
    `${service}: forward recovery preserves the ledger; an older manifest cannot bypass it`,
    { skip: !dockerAvailable, timeout: 120_000 },
    async () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-recovery-'));
      try {
        const source = path.resolve(__dirname, '..', directory);
        const manifest = JSON.parse(fs.readFileSync(path.join(source, 'migrations.json')));
        const old = {
          ...manifest,
          migrations: manifest.migrations.filter((row) => row.version <= oldHead),
        };
        assert.ok(old.migrations.length && old.migrations.length < manifest.migrations.length);
        for (const row of manifest.migrations) {
          const target = path.join(scratch, row.file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(source, row.file), target);
        }
        const oldPath = path.join(scratch, 'migrations.json');
        fs.writeFileSync(oldPath, JSON.stringify(old));
        await withPostgresContainer(async ({ port }) => {
          const owner = await createAdminPool(port);
          let runtime;
          try {
            await owner.query("CREATE ROLE m6_recovery_runtime LOGIN PASSWORD 'local-test-only'");
            const args = {
              pool: owner,
              serviceName: service,
              manifestPath: path.join(source, 'migrations.json'),
              runtimeDbUser: 'm6_recovery_runtime',
            };
            await runVersionedMigrations(args);
            runtime = new Pool({
              host: '127.0.0.1',
              port,
              database: 'postgres',
              user: 'm6_recovery_runtime',
              password: 'local-test-only',
              options: `-c app.service_name=${service}`,
            });
            const before = await owner.query(
              'SELECT * FROM cotsel_schema_migrations ORDER BY service_name, version',
            );
            await assert.rejects(
              assertMigrationHistory({
                pool: runtime,
                serviceName: service,
                manifestPath: oldPath,
              }),
              /migration|manifest|schema/i,
            );
            await assertMigrationHistory({
              pool: runtime,
              serviceName: service,
              manifestPath: args.manifestPath,
            });
            assert.deepEqual((await runVersionedMigrations(args)).applied, []);
            assert.deepEqual(
              (
                await owner.query(
                  'SELECT * FROM cotsel_schema_migrations ORDER BY service_name, version',
                )
              ).rows,
              before.rows,
            );
            assert.equal(
              (await owner.query('SELECT to_regclass($1) IS NOT NULL AS present', [protectedTable]))
                .rows[0].present,
              true,
            );
          } finally {
            await runtime?.end();
            await owner.end();
          }
        });
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
}
