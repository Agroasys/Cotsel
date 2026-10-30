import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { Pool, type PoolClient } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import type { LedgerEntryForExport } from '../src/database/queries/ledger';
import type { TreasuryEntryEligibility } from '../src/types';
import type { TreasuryEligibilityService } from '../src/core/exportEligibility';
import type { SnapshotEligibilityContext } from '../src/core/exportEligibilityContext';
import type { TradeReconciliationGate } from '../src/core/reconciliationGate';
import type { ChainCanonicalityVerifier } from '../src/core/chainCanonicality';
import { freshIngestion } from './helpers/ingestionFreshness';
import { snapshotReconciliationFixture } from './helpers/exportSnapshotReconciliation';
import {
  alwaysCanonicalVerifier,
  TEST_BLOCK_HASH,
  TEST_LOG_ADDRESS,
  TEST_LOG_IDENTITY_HASH,
} from './helpers/chainCanonicality';

const describePostgres = process.env.TREASURY_POSTGRES_TESTS === 'true' ? describe : describe.skip;

describePostgres('treasury export snapshot migration', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `treasury_snapshot_${suffix}`;
  const runtimeRole = `treasury_snapshot_${suffix}`;
  const connection = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  let admin: Pool;
  let pool: Pool;
  let runtime: PoolClient;
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
    runtime = await pool.connect();
    await runtime.query(`SET ROLE "${runtimeRole}"`);
    await runtime.query("SET app.service_name = 'treasury'");
  }, 60000);

  afterAll(async () => {
    await closeServiceConnection?.();
    runtime?.release();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin?.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    await admin?.end();
  }, 60000);

  test('enforces service isolation, job identity and completed evidence retention', async () => {
    const id = randomUUID();
    await expect(
      runtime.query(
        `INSERT INTO treasury_export_jobs
      (id, caller_id, idempotency_key_hash, request_hash, cutoff, status, attempt, access_expires_at)
      VALUES ($1, 'service:a', $2, $3, NOW(), 'COMPLETE', 1, NOW() + interval '24 hours')`,
        [randomUUID(), 'c'.repeat(64), 'd'.repeat(64)],
      ),
    ).rejects.toThrow('treasury_export_job_must_start_building');
    const job = `INSERT INTO treasury_export_jobs
      (id, caller_id, idempotency_key_hash, request_hash, cutoff, status, attempt, access_expires_at)
      VALUES ($1, 'service:a', $2, $3, NOW(), 'BUILDING', 1, NOW() + interval '24 hours')`;
    await runtime.query(job, [id, 'a'.repeat(64), 'b'.repeat(64)]);
    await runtime.query(
      `INSERT INTO treasury_export_rows (job_id, attempt, position, ledger_entry_id, captured_row, source_evidence)
      VALUES ($1, 1, 0, 1, '{"amount_raw":"1","block_number":100}', '{}')`,
      [id],
    );
    await expect(
      runtime.query('UPDATE treasury_export_jobs SET caller_id = $2 WHERE id = $1', [
        id,
        'service:b',
      ]),
    ).rejects.toThrow('treasury_export_job_identity_is_immutable');
    await runtime.query("SET app.service_name = 'other'");
    expect(
      (await runtime.query('SELECT id FROM treasury_export_jobs WHERE id = $1', [id])).rowCount,
    ).toBe(0);
    await runtime.query("SET app.service_name = 'treasury'");
    await expect(
      runtime.query('DELETE FROM treasury_export_rows WHERE job_id = $1', [id]),
    ).rejects.toThrow(/permission denied/);
    const complete = `UPDATE treasury_export_jobs SET status='COMPLETE', completed_at=NOW(), candidate_count=1,
      candidate_amount_raw='1', chain_context=jsonb_build_object('finalizedBlockHash', '0x' || repeat('ab',32), 'finalizedBlockNumber', 110),
      reconciliation_context='{"runKey":"run-1"}', ingestion_context='{"status":"FRESH"}' WHERE id=$1`;
    await expect(runtime.query(complete, [id])).rejects.toThrow(
      'treasury_export_snapshot_is_incomplete',
    );
    await runtime.query("UPDATE treasury_export_rows SET eligibility='{}' WHERE job_id=$1", [id]);
    await expect(runtime.query(complete, [id])).rejects.toThrow(
      'treasury_export_eligibility_is_incomplete',
    );
    await runtime.query(
      `UPDATE treasury_export_rows SET eligibility='{"eligibleForPayout":false,"eligibleForExport":false,"blockedReasons":["orphaned"],"exportBlockedReasons":["orphaned"],"canonicalityState":"ORPHANED","reconciliationEvidence":{"runKey":"run-1","freshness":"FRESH","coverageComplete":true,"coverageToBlock":110}}' WHERE job_id=$1`,
      [id],
    );
    await runtime.query(complete, [id]);
    await expect(
      runtime.query("UPDATE treasury_export_jobs SET failure_code='changed' WHERE id=$1", [id]),
    ).rejects.toThrow('treasury_export_job_is_retained');
    await expect(
      runtime.query("UPDATE treasury_export_rows SET eligibility='{}' WHERE job_id=$1", [id]),
    ).rejects.toThrow('treasury_export_rows_are_retained');
    process.env.PORT = '3200';
    process.env.DB_HOST = connection.host;
    process.env.DB_PORT = String(connection.port);
    process.env.DB_NAME = database;
    process.env.DB_USER = connection.user;
    process.env.DB_PASSWORD = connection.password;
    process.env.INDEXER_GRAPHQL_URL = 'http://127.0.0.1:3100/graphql';
    const { ExportSnapshotTokens } = await import('../src/database/exportSnapshotTokens');
    ({ closeConnection: closeServiceConnection } = await import('../src/database/connection'));
    const tokens = new ExportSnapshotTokens(runtime as unknown as Pool);
    const token = await tokens.issue('service:a', id, 7);
    expect(await tokens.resolve('service:a', id, token)).toBe(7);
    expect(await tokens.resolve('service:b', id, token)).toBeNull();
    expect(await tokens.resolve('service:a', randomUUID(), token)).toBeNull();
    expect(await tokens.resolve('service:a', id, `${token.slice(0, -1)}!`)).toBeNull();
    await pool.query(
      "UPDATE treasury_export_tokens SET expires_at=NOW() - interval '1 second' WHERE job_id=$1",
      [id],
    );
    expect(await tokens.resolve('service:a', id, token)).toBeNull();
    await expect(
      runtime.query(
        `INSERT INTO treasury_export_rows (job_id, attempt, position, ledger_entry_id, captured_row, source_evidence)
      VALUES ($1, 1, 1, 2, '{}', '{}')`,
        [id],
      ),
    ).rejects.toThrow('treasury_export_rows_are_retained');
  });

  test('captures over 5000 candidates after a failed size-limited attempt', async () => {
    await pool.query(`INSERT INTO treasury_ledger_entries
      (entry_key, trade_id, tx_hash, block_number, event_name, component_type, amount_raw, source_timestamp, created_at)
      SELECT 'entry-' || n, 'trade-' || n, 'tx-' || n, 100, 'fee', 'PLATFORM_FEE', '42',
             TIMESTAMP '2019-01-01', TIMESTAMP '2019-01-01' FROM generate_series(1, 5002) n`);
    await pool.query(
      "UPDATE treasury_ledger_entries SET canonicality_state='ORPHANED' WHERE created_at=TIMESTAMP '2019-01-01'",
    );
    process.env.PORT = '3200';
    process.env.DB_HOST = connection.host;
    process.env.DB_PORT = String(connection.port);
    process.env.DB_NAME = database;
    process.env.DB_USER = connection.user;
    process.env.DB_PASSWORD = connection.password;
    process.env.INDEXER_GRAPHQL_URL = 'http://127.0.0.1:3100/graphql';
    const { ExportSnapshotStore } = await import('../src/database/exportSnapshotStore');
    const servicePool = new Pool({
      ...connection,
      database,
      options: `-c role=${runtimeRole} -c app.service_name=treasury -c app.runtime_db_user=${runtimeRole}`,
    });
    try {
      const store = new ExportSnapshotStore(servicePool);
      const cutoff = new Date('2020-01-01T00:00:00.000Z');
      const job = await store.create('service:a', 'snapshot-key', cutoff);
      expect((await store.create('service:a', 'snapshot-key', cutoff)).id).toBe(job.id);
      await expect(
        store.create('service:a', 'snapshot-key', new Date('2021-01-01T00:00:00Z')),
      ).rejects.toThrow('Idempotency key is bound to a different export request');
      expect(await store.get('service:b', job.id)).toBeNull();
      const owner = randomUUID();
      const claims = await Promise.all([
        store.claim(job.id, owner, 60),
        store.claim(job.id, randomUUID(), 60),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const selectedOwner = claims[0] ? owner : claims[1]!.lease_owner!;
      await expect(store.capture(job.id, selectedOwner, 5001)).rejects.toThrow(
        'Export job size limit exceeded',
      );
      expect(await store.get('service:a', job.id)).toMatchObject({
        status: 'FAILED',
        failure_code: 'JOB_SIZE_LIMIT_EXCEEDED',
      });
      const retryOwner = randomUUID();
      expect((await store.claim(job.id, retryOwner, 60))?.attempt).toBe(2);
      await store.capture(job.id, retryOwner, 6000);
      const captured = await servicePool.query(
        `SELECT COUNT(*)::int AS count, COUNT(DISTINCT ledger_entry_id)::int AS unique_count,
        SUM((captured_row->>'amount_raw')::numeric)::text AS total FROM treasury_export_rows WHERE job_id=$1 AND attempt=2`,
        [job.id],
      );
      expect(captured.rows[0]).toEqual({ count: 5002, unique_count: 5002, total: '210084' });
      expect(await store.get('service:a', job.id)).toMatchObject({
        status: 'BUILDING',
        candidate_count: '5002',
        candidate_amount_raw: '210084',
      });
      await servicePool.query(
        `UPDATE treasury_export_rows SET eligibility='{"canonicalityState":"ORPHANED"}' WHERE job_id=$1 AND attempt=2`,
        [job.id],
      );
      const { capturedSourcesMatch } = await import('../src/database/exportSnapshotVerification');
      const checkSources = async (): Promise<boolean> => {
        const client = await servicePool.connect();
        try {
          await client.query('BEGIN');
          const matches = await capturedSourcesMatch(client, job.id, 2, cutoff);
          await client.query('COMMIT');
          return matches;
        } finally {
          client.release();
        }
      };
      expect(await checkSources()).toBe(true);
      const verification = await servicePool.connect();
      const writer = await pool.connect();
      try {
        await verification.query('BEGIN');
        expect(await capturedSourcesMatch(verification, job.id, 2, cutoff)).toBe(true);
        await writer.query("SET lock_timeout = '100ms'");
        await expect(
          writer.query(
            "UPDATE treasury_ledger_entries SET trade_id=trade_id || '-racing' WHERE id=(SELECT min(id) FROM treasury_ledger_entries)",
          ),
        ).rejects.toThrow(/lock timeout/);
        await verification.query('COMMIT');
      } finally {
        await verification.query('ROLLBACK');
        verification.release();
        writer.release();
      }
      await pool.query(`WITH removed AS (
        DELETE FROM treasury_ledger_entries WHERE id=(SELECT min(id) FROM treasury_ledger_entries)
        RETURNING entry_key, trade_id, tx_hash, block_number, event_name, component_type, amount_raw, source_timestamp, created_at, canonicality_state
      ) INSERT INTO treasury_ledger_entries
        (entry_key, trade_id, tx_hash, block_number, event_name, component_type, amount_raw, source_timestamp, created_at, canonicality_state)
        SELECT entry_key, trade_id, tx_hash, block_number, event_name, component_type, amount_raw, source_timestamp, created_at, canonicality_state FROM removed`);
      expect(await checkSources()).toBe(false);

      const { ExportSnapshotBuilder } = await import('../src/core/exportSnapshotBuilder');
      let mutateBeforePublish = true;
      const fakeEligibility = {
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
          const result = new Map<number, TreasuryEntryEligibility>();
          for (const entry of entries) {
            context.reconciliationByTradeId.set(entry.trade_id, {
              runKey: 'run-1',
              freshness: 'FRESH',
              coverageComplete: true,
              coverageToBlock: 110,
            } as TradeReconciliationGate);
            result.set(entry.id, {
              entryId: entry.id,
              canonicalityState: 'ORPHANED',
              eligibleForExport: false,
              eligibleForPayout: false,
              blockedReasons: ['orphaned'],
            } as TreasuryEntryEligibility);
          }
          return result;
        },
        verifySnapshotContext: async () => {
          if (mutateBeforePublish) {
            mutateBeforePublish = false;
            await pool.query(
              "UPDATE treasury_ledger_entries SET trade_id=trade_id || '-changed' WHERE id=(SELECT min(id) FROM treasury_ledger_entries)",
            );
          }
        },
      } as unknown as TreasuryEligibilityService;
      const caller = JSON.stringify(['svc', null]);
      const buildJob = await store.create(caller, 'build-key', cutoff);
      const builder = new ExportSnapshotBuilder(servicePool, fakeEligibility);
      await expect(builder.build(buildJob.id, 6000)).rejects.toThrow(
        'Captured ledger sources changed',
      );
      expect(await store.get(caller, buildJob.id)).toMatchObject({
        status: 'FAILED',
        failure_code: 'SOURCE_CHANGED',
      });
      expect(await builder.build(buildJob.id, 6000)).toBe(true);
      expect(await store.get(caller, buildJob.id)).toMatchObject({
        status: 'COMPLETE',
        attempt: 2,
        candidate_count: '5002',
        candidate_amount_raw: '210084',
      });
      const { ExportSnapshotsController } = await import('../src/api/exportSnapshots');
      const controller = new ExportSnapshotsController();
      const seen = new Set<number>();
      let total = 0n;
      let cursor: string | undefined;
      let firstCursor: string | undefined;
      do {
        const status = jest.fn().mockReturnThis();
        const json = jest.fn().mockReturnThis();
        const req = {
          params: { id: buildJob.id },
          query: { limit: '1000', ...(cursor ? { cursor } : {}) },
          serviceAuth: { apiKeyId: 'svc', scheme: 'api_key' },
        } as unknown as Request;
        await controller.entries(req, { status, json } as unknown as Response);
        expect(status).toHaveBeenCalledWith(200);
        const data = json.mock.calls[0][0].data as {
          entries: Array<{ id: number; amount_raw: string; exportBlockedReasons: string[] }>;
          nextCursor: string | null;
        };
        for (const entry of data.entries) {
          expect(seen.has(entry.id)).toBe(false);
          expect(entry.exportBlockedReasons).toEqual(['orphaned']);
          seen.add(entry.id);
          total += BigInt(entry.amount_raw);
        }
        cursor = data.nextCursor ?? undefined;
        firstCursor ??= cursor;
      } while (cursor);
      expect(seen.size).toBe(5002);
      expect(total).toBe(210084n);
      const status = jest.fn().mockReturnThis();
      const json = jest.fn().mockReturnThis();
      const other = {
        params: { id: buildJob.id },
        query: {},
        serviceAuth: { apiKeyId: 'other', scheme: 'api_key' },
      } as unknown as Request;
      await controller.entries(other, { status, json } as unknown as Response);
      expect(status).toHaveBeenCalledWith(404);
      const sharedStatus = jest.fn().mockReturnThis();
      const shared = {
        params: { id: buildJob.id },
        query: {},
        serviceAuth: { apiKeyId: 'svc', scheme: 'shared_secret' },
      } as unknown as Request;
      await controller.entries(shared, {
        status: sharedStatus,
        json: jest.fn(),
      } as unknown as Response);
      expect(sharedStatus).toHaveBeenCalledWith(401);
      const tokenStatus = jest.fn().mockReturnThis();
      const tokenJson = jest.fn().mockReturnThis();
      const altered = `${firstCursor![0] === 'A' ? 'B' : 'A'}${firstCursor!.slice(1)}`;
      const tampered = {
        params: { id: buildJob.id },
        query: { cursor: altered },
        serviceAuth: { apiKeyId: 'svc', scheme: 'api_key' },
      } as unknown as Request;
      await controller.entries(tampered, {
        status: tokenStatus,
        json: tokenJson,
      } as unknown as Response);
      expect(tokenStatus).toHaveBeenCalledWith(400);
      const replayStatus = jest.fn().mockReturnThis();
      const replayJson = jest.fn().mockReturnThis();
      const replay = {
        body: { cutoff: cutoff.toISOString() },
        get: () => 'build-key',
        serviceAuth: { apiKeyId: 'svc', scheme: 'api_key' },
      } as unknown as Request;
      await controller.create(replay, {
        status: replayStatus,
        json: replayJson,
      } as unknown as Response);
      expect(replayStatus).toHaveBeenCalledWith(200);
      expect(replayJson.mock.calls[0][0].data.id).toBe(buildJob.id);
      await pool.query(`INSERT INTO treasury_ledger_entries
        (entry_key, trade_id, tx_hash, block_number, event_name, component_type, amount_raw, source_timestamp, created_at)
        VALUES ('single', 'single', 'tx-single', 100, 'fee', 'PLATFORM_FEE', '42', TIMESTAMP '2017-01-01', TIMESTAMP '2017-01-01')`);
      const { TreasuryEligibilityService } = await import('../src/core/exportEligibility');
      const eligibility = new TreasuryEligibilityService({
        provider: {
          getBlock: async (tag) => ({
            number: tag === 'latest' ? 120 : tag === 'safe' ? 115 : 110,
            hash: `0x${'ab'.repeat(32)}`,
          }),
        },
        ingestionFreshness: freshIngestion(),
        canonicalityVerifier: {
          resetCache() {},
          verify: async () => ({ state: 'UNVERIFIED', detail: 'fixture' }),
        } as unknown as ChainCanonicalityVerifier,
        reconciliationGate: snapshotReconciliationFixture(),
      });
      const realServiceJob = await store.create(
        caller,
        'real-service-key',
        new Date('2018-01-01T00:00:00Z'),
      );
      await expect(
        new ExportSnapshotBuilder(servicePool, eligibility).build(realServiceJob.id, 6000),
      ).rejects.toThrow('Canonical chain evidence is unavailable');
      expect(await store.get(caller, realServiceJob.id)).toMatchObject({
        status: 'FAILED',
        failure_code: 'CANONICALITY_UNAVAILABLE',
      });
      const single = await pool.query(
        `UPDATE treasury_ledger_entries SET block_hash=$1, log_index=0, log_address=$2, log_identity_hash=$3
        WHERE entry_key='single' RETURNING id`,
        [TEST_BLOCK_HASH, TEST_LOG_ADDRESS, TEST_LOG_IDENTITY_HASH],
      );
      await pool.query(
        "INSERT INTO payout_lifecycle_events (ledger_entry_id, state) VALUES ($1, 'READY_FOR_EXTERNAL_HANDOFF')",
        [single.rows[0].id],
      );
      const eligibleService = new TreasuryEligibilityService({
        provider: {
          getBlock: async (tag) => ({
            number: tag === 'latest' ? 120 : tag === 'safe' ? 115 : 110,
            hash: TEST_BLOCK_HASH,
          }),
        },
        ingestionFreshness: freshIngestion(),
        canonicalityVerifier: alwaysCanonicalVerifier(),
        reconciliationGate: snapshotReconciliationFixture(),
      });
      expect(
        await new ExportSnapshotBuilder(servicePool, eligibleService).build(
          realServiceJob.id,
          6000,
        ),
      ).toBe(true);
      expect((await store.get(caller, realServiceJob.id))?.status).toBe('COMPLETE');
      const eligibleRows = await servicePool.query(
        `SELECT captured_row->>'amount_raw' AS amount, eligibility FROM treasury_export_rows WHERE job_id=$1 AND attempt=2`,
        [realServiceJob.id],
      );
      expect(eligibleRows.rows).toHaveLength(1);
      expect(eligibleRows.rows[0]).toMatchObject({
        amount: '42',
        eligibility: {
          eligibleForExport: true,
          reconciliationRunKey: 'run-1',
          reconciliationCoverageToBlock: 110,
          exportBlockedReasons: [],
        },
      });
      const emptyJob = await store.create(caller, 'empty-key', new Date('2010-01-01T00:00:00Z'));
      expect(
        await new ExportSnapshotBuilder(servicePool, eligibility).build(emptyJob.id, 6000),
      ).toBe(true);
      expect(await store.get(caller, emptyJob.id)).toMatchObject({
        status: 'COMPLETE',
        candidate_count: '0',
        candidate_amount_raw: '0',
      });
    } finally {
      await servicePool.end();
    }
  }, 60000);
});
