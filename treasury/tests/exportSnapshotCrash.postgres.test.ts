import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import type { Request, Response } from 'express';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import type { LedgerEntryForExport } from '../src/database/queries/ledger';
import type { TreasuryEntryEligibility } from '../src/types';
import type { TreasuryEligibilityService } from '../src/core/exportEligibility';
import type { SnapshotEligibilityContext } from '../src/core/exportEligibilityContext';
import type { TradeReconciliationGate } from '../src/core/reconciliationGate';

const describePostgres = process.env.TREASURY_POSTGRES_TESTS === 'true' ? describe : describe.skip;
describePostgres('treasury export crash recovery', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `treasury_crash_${suffix}`;
  const runtimeRole = `treasury_crash_${suffix}`;
  const connection = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  let admin: Pool;
  let pool: Pool;
  let closeServiceConnection: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    admin = new Pool({ ...connection, database: 'postgres' });
    await admin.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
    await admin.query(`CREATE DATABASE "${database}"`);
    pool = new Pool({
      ...connection,
      database,
      options: `-c app.service_name=treasury -c app.runtime_db_user=${runtimeRole}`,
    });
    await runVersionedMigrations({
      pool,
      serviceName: 'treasury',
      manifestPath: path.resolve(__dirname, '../src/database/migrations.json'),
      runtimeDbUser: runtimeRole,
    });
    process.env.PORT = '3200';
    process.env.DB_HOST = connection.host;
    process.env.DB_PORT = String(connection.port);
    process.env.DB_NAME = database;
    process.env.DB_USER = connection.user;
    process.env.DB_PASSWORD = connection.password;
    process.env.INDEXER_GRAPHQL_URL = 'http://127.0.0.1:3100/graphql';
    ({ closeConnection: closeServiceConnection } = await import('../src/database/connection'));
  }, 60000);
  afterAll(async () => {
    await closeServiceConnection?.();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin?.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    await admin?.end();
  }, 60000);
  test('a killed capture rolls back and a retry takes a fresh snapshot', async () => {
    await pool.query(`INSERT INTO treasury_ledger_entries
      (entry_key, trade_id, tx_hash, block_number, event_name, component_type, amount_raw, source_timestamp, created_at)
      VALUES ('crash-entry', 'crash-trade', 'tx-crash', 100, 'fee', 'PLATFORM_FEE', '42', TIMESTAMP '1999-01-01', TIMESTAMP '1999-01-01')`);
    const { ExportSnapshotStore } = await import('../src/database/exportSnapshotStore');
    const servicePool = new Pool({
      ...connection,
      database,
      options: `-c role=${runtimeRole} -c app.service_name=treasury -c app.runtime_db_user=${runtimeRole}`,
    });
    const store = new ExportSnapshotStore(servicePool);
    const cutoff = new Date('2000-01-01T00:00:00Z');
    const job = await store.create('crash-test', 'crash-key', cutoff);
    const owner = randomUUID();
    expect(await store.claim(job.id, owner, 300)).not.toBeNull();
    const blocker = await pool.connect();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE treasury_ledger_entries IN ACCESS EXCLUSIVE MODE');
      child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          '-e',
          `
        const { ExportSnapshotStore } = require('./src/database/exportSnapshotStore');
        process.stdout.write('started\\n');
        new ExportSnapshotStore().capture(process.env.TEST_JOB, process.env.TEST_OWNER, 6000)
          .then(() => process.exit(0)).catch(() => process.exit(1));
      `,
        ],
        {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            DB_NAME: database,
            DB_HOST: connection.host,
            DB_PORT: String(connection.port),
            DB_USER: connection.user,
            DB_PASSWORD: connection.password,
            TEST_JOB: job.id,
            TEST_OWNER: owner,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await once(child.stdout!, 'data');
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='treasury-runtime' AND wait_event_type='Lock'",
          [database],
        );
        blocked = waiting.rowCount === 1;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      await blocker.query('ROLLBACK');
      const partial = await servicePool.query(
        'SELECT COUNT(*)::int AS count FROM treasury_export_rows WHERE job_id=$1',
        [job.id],
      );
      expect(partial.rows[0].count).toBe(0);
      expect((await store.get('crash-test', job.id))?.status).toBe('BUILDING');
      await pool.query(
        "UPDATE treasury_export_jobs SET lease_expires_at=NOW()-interval '1 second' WHERE id=$1",
        [job.id],
      );
      expect((await store.create('crash-test', 'crash-key', cutoff)).id).toBe(job.id);
      const retryOwner = randomUUID();
      expect((await store.claim(job.id, retryOwner, 300))?.attempt).toBe(2);
      await store.capture(job.id, retryOwner, 6000);
      expect(await store.get('crash-test', job.id)).toMatchObject({
        attempt: 2,
        candidate_count: '1',
        candidate_amount_raw: '42',
      });
    } finally {
      if (child) child.kill('SIGKILL');
      await blocker.query('ROLLBACK');
      blocker.release();
      await servicePool.end();
    }
  }, 60000);

  test('a killed builder cannot expose partial decisions and retries from a fresh attempt', async () => {
    await pool.query(`INSERT INTO treasury_ledger_entries
      (entry_key, trade_id, tx_hash, block_number, event_name, component_type, amount_raw, source_timestamp, created_at)
      SELECT 'mid-' || n, 'mid-' || n, 'mid-' || n, 100, 'fee', 'PLATFORM_FEE', '42',
             TIMESTAMP '1980-01-01', TIMESTAMP '1980-01-01' FROM generate_series(1, 501) n`);
    await pool.query(
      "UPDATE treasury_ledger_entries SET canonicality_state='ORPHANED' WHERE created_at=TIMESTAMP '1980-01-01'",
    );
    const { ExportSnapshotStore } = await import('../src/database/exportSnapshotStore');
    const servicePool = new Pool({
      ...connection,
      database,
      options: `-c role=${runtimeRole} -c app.service_name=treasury -c app.runtime_db_user=${runtimeRole}`,
    });
    const store = new ExportSnapshotStore(servicePool);
    const caller = createHash('sha256')
      .update(JSON.stringify(['svc', null]))
      .digest('hex');
    const cutoff = new Date('1981-01-01T00:00:00Z');
    const job = await store.create(caller, 'mid-crash', cutoff);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          '-e',
          `
        const { ExportSnapshotBuilder } = require('./src/core/exportSnapshotBuilder');
        let calls = 0;
        const fake = {
          createSnapshotContext: async () => ({ heads: { latestBlockNumber: 120, safeBlockNumber: 115, finalizedBlockNumber: 110 },
            finalizedBlockHash: '0x' + 'ab'.repeat(32), ingestion: { status: 'FRESH' }, reconciliationRunKey: 'run-1', reconciliationByTradeId: new Map() }),
          assessEntries: async (entries, context) => {
            if (++calls === 2) { process.stdout.write('paused\\n'); return await new Promise(() => {}); }
            const result = new Map();
            for (const e of entries) { context.reconciliationByTradeId.set(e.trade_id, { runKey: 'run-1', freshness: 'FRESH', coverageComplete: true, coverageToBlock: 110 }); result.set(e.id, { entryId: e.id, canonicalityState: 'ORPHANED', eligibleForExport: false, eligibleForPayout: false, blockedReasons: ['orphaned'] }); }
            return result;
          },
          verifySnapshotContext: async () => {},
        };
        new ExportSnapshotBuilder(undefined, fake).build(process.env.TEST_JOB, 6000)
          .then(() => process.exit(0)).catch(() => process.exit(1));
      `,
        ],
        {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            DB_NAME: database,
            DB_HOST: connection.host,
            DB_PORT: String(connection.port),
            DB_USER: connection.user,
            DB_PASSWORD: connection.password,
            TEST_JOB: job.id,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await once(child.stdout!, 'data');
      const partial = await servicePool.query(
        `SELECT COUNT(*) FILTER (WHERE eligibility IS NOT NULL)::int AS assessed
        FROM treasury_export_rows WHERE job_id=$1 AND attempt=1`,
        [job.id],
      );
      expect(partial.rows[0].assessed).toBe(500);
      const { ExportSnapshotsController } = await import('../src/api/exportSnapshots');
      const status = jest.fn().mockReturnThis();
      const json = jest.fn().mockReturnThis();
      const req = {
        params: { id: job.id },
        query: {},
        serviceAuth: { apiKeyId: 'svc', scheme: 'api_key' },
      } as unknown as Request;
      await new ExportSnapshotsController().entries(req, { status, json } as unknown as Response);
      expect(status).toHaveBeenCalledWith(409);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      await pool.query(
        "UPDATE treasury_export_jobs SET lease_expires_at=NOW()-interval '1 second' WHERE id=$1",
        [job.id],
      );
      expect((await store.create(caller, 'mid-crash', cutoff)).id).toBe(job.id);
      const fake = {
        createSnapshotContext: async () =>
          ({
            heads: { latestBlockNumber: 120, safeBlockNumber: 115, finalizedBlockNumber: 110 },
            finalizedBlockHash: `0x${'ab'.repeat(32)}`,
            ingestion: { status: 'FRESH' },
            reconciliationRunKey: 'run-1',
            reconciliationByTradeId: new Map(),
          }) as unknown as SnapshotEligibilityContext,
        assessEntries: async (
          entries: LedgerEntryForExport[],
          context: SnapshotEligibilityContext,
        ) => {
          const verdicts = new Map<number, TreasuryEntryEligibility>();
          for (const entry of entries) {
            context.reconciliationByTradeId.set(entry.trade_id, {
              runKey: 'run-1',
              freshness: 'FRESH',
              coverageComplete: true,
              coverageToBlock: 110,
            } as TradeReconciliationGate);
            verdicts.set(entry.id, {
              entryId: entry.id,
              canonicalityState: 'ORPHANED',
              eligibleForExport: false,
              eligibleForPayout: false,
              blockedReasons: ['orphaned'],
            } as TreasuryEntryEligibility);
          }
          return verdicts;
        },
        verifySnapshotContext: async () => {},
      } as unknown as TreasuryEligibilityService;
      const { ExportSnapshotBuilder } = await import('../src/core/exportSnapshotBuilder');
      expect(await new ExportSnapshotBuilder(servicePool, fake).build(job.id, 6000)).toBe(true);
      expect(await store.get(caller, job.id)).toMatchObject({
        status: 'COMPLETE',
        attempt: 2,
        candidate_count: '501',
        candidate_amount_raw: '21042',
      });
    } finally {
      if (child) child.kill('SIGKILL');
      await servicePool.end();
    }
  }, 60000);
});
