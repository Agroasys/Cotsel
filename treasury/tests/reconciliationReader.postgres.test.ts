import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import {
  completeAndSealRun,
  TEST_FINDING_PUBLIC_KEYS_JSON,
} from './helpers/sealedReconciliationRun';

const describePostgres = process.env.TREASURY_POSTGRES_TESTS === 'true' ? describe : describe.skip;

describePostgres('reconciliation reader row security', () => {
  test('reads scoped evidence using the configured restricted identity', async () => {
    const suffix = randomBytes(6).toString('hex');
    const database = `treasury_recon_${suffix}`;
    const runtimeRole = `recon_runtime_${suffix}`;
    const readerRole = `recon_reader_${suffix}`;
    const connection = {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    };
    const admin = new Pool({ ...connection, database: 'postgres' });
    let db: Pool | undefined;
    let noContext: Pool | undefined;
    let service: import('../src/core/reconciliationGate').ReconciliationGateService | undefined;
    try {
      await admin.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
      await admin.query(
        `CREATE ROLE "${readerRole}" LOGIN PASSWORD 'fixture-password' NOSUPERUSER NOBYPASSRLS`,
      );
      await admin.query(`CREATE DATABASE "${database}"`);
      db = new Pool({
        ...connection,
        database,
        options: `-c app.service_name=reconciliation -c app.runtime_db_user=${runtimeRole}`,
      });
      await runVersionedMigrations({
        pool: db,
        serviceName: 'reconciliation',
        manifestPath: path.resolve(__dirname, '../../reconciliation/src/database/migrations.json'),
        runtimeDbUser: runtimeRole,
      });
      await db.query(`GRANT USAGE ON SCHEMA public TO "${readerRole}"`);
      await db.query(
        `GRANT SELECT ON reconcile_runs, reconcile_run_trades, reconcile_drifts, reconcile_run_manifests TO "${readerRole}"`,
      );
      const run =
        await db.query(`INSERT INTO reconcile_runs (run_key, mode, status, completed_at, coverage_from_block, coverage_to_block, coverage_complete)
        VALUES ('run-1', 'ONCE', 'RUNNING', NULL, 0, 110, true) RETURNING id`);
      await db.query(
        "INSERT INTO reconcile_run_trades (run_id, run_key, trade_id) VALUES ($1, 'run-1', 'trade-1')",
        [run.rows[0].id],
      );
      await completeAndSealRun(
        db,
        'run-1',
        "UPDATE reconcile_runs SET status='COMPLETED', completed_at=NOW() AT TIME ZONE 'UTC' WHERE run_key='run-1'",
      );
      noContext = new Pool({
        host: connection.host,
        port: connection.port,
        database,
        user: readerRole,
        password: 'fixture-password',
      });
      expect((await noContext.query('SELECT * FROM reconcile_runs')).rowCount).toBe(0);
      process.env.PORT = '3200';
      process.env.DB_HOST = connection.host;
      process.env.DB_PORT = String(connection.port);
      process.env.DB_NAME = database;
      process.env.DB_USER = connection.user;
      process.env.DB_PASSWORD = connection.password;
      process.env.INDEXER_GRAPHQL_URL = 'http://127.0.0.1:3100/graphql';
      process.env.RECONCILIATION_DB_NAME = database;
      process.env.RECONCILIATION_DB_HOST = connection.host;
      process.env.RECONCILIATION_DB_PORT = String(connection.port);
      process.env.RECONCILIATION_DB_USER = readerRole;
      process.env.RECONCILIATION_DB_PASSWORD = 'fixture-password';
      process.env.RECONCILIATION_DB_SSL_MODE = 'disable';
      process.env.RECONCILIATION_FINDING_PUBLIC_KEYS = TEST_FINDING_PUBLIC_KEYS_JSON;
      const { ReconciliationGateService } = await import('../src/core/reconciliationGate');
      service = new ReconciliationGateService();
      expect((await service.assessTrades(['trade-1'])).get('trade-1')).toMatchObject({
        status: 'CLEAR',
        runKey: 'run-1',
        coverageToBlock: 110,
        coverageComplete: true,
      });
      expect(await service.snapshotRunAnchor({ requireImmutable: true })).toMatchObject({
        evidenceVersion: 1,
        runKey: 'run-1',
        coverageToBlock: 110,
      });
      expect(
        (await service.assessTrades(['trade-1'], { runKey: 'run-1', requireImmutable: true })).get(
          'trade-1',
        )?.status,
      ).toBe('CLEAR');
      await expect(
        noContext.query("UPDATE reconcile_runs SET status='FAILED' WHERE run_key='run-1'"),
      ).rejects.toThrow(/permission denied/);

      // Cotsel#951: a scope row injected past the published-evidence triggers
      // (as a database owner could) would clear a trade never compared; the
      // signed manifest no longer matches, so the gate blocks the whole run.
      const owner = await db.connect();
      try {
        await owner.query('BEGIN');
        await owner.query('SET LOCAL session_replication_role = replica');
        await owner.query(
          "INSERT INTO reconcile_run_trades (run_id, run_key, trade_id) VALUES ($1, 'run-1', 'trade-2')",
          [run.rows[0].id],
        );
        await owner.query('COMMIT');
      } finally {
        owner.release();
      }
      const forged = (await service.assessTrades(['trade-1', 'trade-2'])).get('trade-2');
      expect(forged?.status).toBe('BLOCKED');
      expect(forged?.blockedReasons.join(' ')).toContain('reconciliation_evidence_invalid');
    } finally {
      await service?.close();
      await noContext?.end();
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  }, 60000);
});
