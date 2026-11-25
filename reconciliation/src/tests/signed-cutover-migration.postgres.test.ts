import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { assertMigrationHistory, runVersionedMigrations } from '@agroasys/shared-db/migrate';
import {
  createAdminPool,
  dockerAvailable,
  MANIFEST_PATH,
  RUNTIME_ROLE,
  withPostgresContainer,
} from './helpers/reconciliationPostgres';

test(
  'signing cutover refuses open legacy containments before it changes migration history',
  { timeout: 180000, skip: !dockerAvailable },
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'reconciliation-unsigned-'));
    try {
      const prefix = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')).migrations.filter(
        (migration: { version: string }) => migration.version <= '202611230001',
      );
      for (const migration of prefix) {
        await copyFile(
          path.resolve(path.dirname(MANIFEST_PATH), migration.file),
          path.join(scratch, migration.file),
        );
      }
      const oldManifestPath = path.join(scratch, 'migrations.json');
      await writeFile(oldManifestPath, JSON.stringify({ migrations: prefix }));

      await withPostgresContainer(async ({ port }: { port: number }) => {
        const admin = await createAdminPool(port);
        try {
          await admin.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
          await admin.query("CREATE ROLE reconciliation_migrator LOGIN PASSWORD 'local-test-only'");
          await admin.query('CREATE DATABASE recon_cutover OWNER reconciliation_migrator');
        } finally {
          await admin.end();
        }
        const pool = new Pool({
          host: '127.0.0.1',
          port,
          database: 'recon_cutover',
          user: 'reconciliation_migrator',
          password: 'local-test-only',
          max: 1,
        });
        try {
          const args = { pool, serviceName: 'reconciliation', runtimeDbUser: RUNTIME_ROLE };
          await runVersionedMigrations({ ...args, manifestPath: oldManifestPath });
          await pool.query("SET app.service_name = 'reconciliation'");
          await pool.query(`INSERT INTO reconcile_trade_containments
            (trade_id, incident_reference, state, opened_run_key, evidence)
            VALUES ('7', 'RECON-LEGACY', 'CONTAINED', 'unsigned-opening',
                    '{"findings":[{"mismatchCode":"AMOUNT_MISMATCH"}]}')`);
          await pool.query('RESET app.service_name');

          for (const state of ['CONTAINED', 'RECONCILED_PENDING_APPROVAL']) {
            await pool.query("SET app.service_name = 'reconciliation'");
            await pool.query('UPDATE reconcile_trade_containments SET state = $1', [state]);
            await pool.query('RESET app.service_name');
            await assert.rejects(
              runVersionedMigrations({ ...args, manifestPath: MANIFEST_PATH }),
              /reconciliation_signed_cutover_open_legacy_containment/,
            );
            await assertMigrationHistory({ ...args, manifestPath: oldManifestPath });
            assert.equal(
              (
                await pool.query(
                  "SELECT to_regclass('public.reconcile_run_manifests') AS manifests",
                )
              ).rows[0].manifests,
              null,
            );
          }

          // Simulate an already recorded governed release on the old runtime.
          await pool.query("SET app.service_name = 'reconciliation'");
          await pool.query(`UPDATE reconcile_trade_containments SET state = 'RELEASED',
             approval_tx_hash = '0x01', approval_chain_id = 31337, approval_contract = '0x02',
             approval_block_number = 1, approval_log_index = 0, approval_incident_ref = '0x03',
             pause_observed_at = now(), released_at = now()`);
          await pool.query('RESET app.service_name');
          await runVersionedMigrations({ ...args, manifestPath: MANIFEST_PATH });
          await assertMigrationHistory({ ...args, manifestPath: MANIFEST_PATH });
          await pool.query("SET app.service_name = 'reconciliation'");
          const { rows } =
            await pool.query(`SELECT incident_reference, state, cited_findings, evidence
            FROM reconcile_trade_containments`);
          assert.deepEqual(rows, [
            {
              incident_reference: 'RECON-LEGACY',
              state: 'RELEASED',
              cited_findings: [],
              evidence: { findings: [{ mismatchCode: 'AMOUNT_MISMATCH' }] },
            },
          ]);
          assert.equal(
            (await pool.query('SELECT count(*) FROM reconcile_run_manifests')).rows[0].count,
            '0',
          );
        } finally {
          await pool.end();
        }
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
