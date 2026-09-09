import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { assertMigrationHistory, runVersionedMigrations } from '@agroasys/shared-db/migrate';

// postgres-test-support is untyped CommonJS test tooling, not part of the
// shared-db public type surface.
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('../../../shared-db/postgres-test-support');
/* eslint-enable @typescript-eslint/no-require-imports */

const MANIFEST_PATH = path.resolve(__dirname, '..', 'database', 'migrations.json');
const RUNTIME_ROLE = 'cotsel_reconciliation_runtime';

interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

function servicePool(port: number, database: string): QueryablePool {
  return new Pool({
    host: '127.0.0.1',
    port,
    database,
    user: 'postgres',
    password: 'postgres',
    // RLS on every reconcile table keys off this setting.
    options: `-c app.service_name=reconciliation -c app.runtime_db_user=${RUNTIME_ROLE}`,
  }) as QueryablePool;
}

async function withMigratedDatabase(fn: (pool: QueryablePool) => Promise<void>): Promise<void> {
  await withPostgresContainer(async ({ port }: { port: number }) => {
    const admin = await createAdminPool(port);
    try {
      await admin.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
      await admin.query('CREATE DATABASE cotsel_reconciliation_coverage');
    } finally {
      await admin.end();
    }

    const pool = servicePool(port, 'cotsel_reconciliation_coverage');
    try {
      await runVersionedMigrations({
        pool,
        serviceName: 'reconciliation',
        manifestPath: MANIFEST_PATH,
        runtimeDbUser: RUNTIME_ROLE,
      });
      await fn(pool);
    } finally {
      await pool.end();
    }
  });
}

test(
  'the coverage migration applies and matches its declared schema fingerprint',
  { timeout: 180000, skip: !dockerAvailable },
  async () => {
    await withMigratedDatabase(async (pool) => {
      // Fails if the manifest versions, checksums, or pinned schema fingerprint
      // do not describe the schema the migrations actually produced.
      await assertMigrationHistory({
        pool,
        serviceName: 'reconciliation',
        manifestPath: MANIFEST_PATH,
      });

      const applied = await pool.query(
        `SELECT version, name FROM cotsel_schema_migrations
         WHERE service_name = 'reconciliation' ORDER BY version`,
      );
      assert.deepEqual(
        applied.rows.map((row) => [row.version, row.name]),
        [
          ['202608310001', 'baseline'],
          ['202609090001', 'chain_coverage'],
        ],
      );
    });
  },
);

test(
  'a completed run can publish its covered range, block interval, and next cursor',
  { timeout: 180000, skip: !dockerAvailable },
  async () => {
    await withMigratedDatabase(async (pool) => {
      const columns = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'reconcile_runs'
           AND column_name IN (
             'coverage_from_trade_id','coverage_to_trade_id','coverage_from_block',
             'coverage_to_block','chain_trade_counter','next_cursor',
             'uncovered_tail','coverage_complete'
           )
         ORDER BY column_name`,
      );

      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        [
          'chain_trade_counter',
          'coverage_complete',
          'coverage_from_block',
          'coverage_from_trade_id',
          'coverage_to_block',
          'coverage_to_trade_id',
          'next_cursor',
          'uncovered_tail',
        ],
      );

      await pool.query(
        `INSERT INTO reconcile_runs (run_key, mode, status) VALUES ('run-1', 'ONCE', 'RUNNING')`,
      );
      await pool.query(
        `UPDATE reconcile_runs
         SET status = 'COMPLETED',
             coverage_from_trade_id = 1,
             coverage_to_trade_id = 1000,
             coverage_from_block = 900,
             coverage_to_block = 1000,
             chain_trade_counter = 2500,
             next_cursor = 1000,
             uncovered_tail = 1500,
             coverage_complete = false
         WHERE run_key = 'run-1'`,
      );

      const run = await pool.query(
        `SELECT coverage_to_trade_id::text AS covered_to,
                uncovered_tail::text AS tail,
                coverage_complete
         FROM reconcile_runs WHERE run_key = 'run-1'`,
      );
      assert.equal(run.rows[0].covered_to, '1000');
      // A truncated sweep is legible as truncated rather than reported clean.
      assert.equal(run.rows[0].tail, '1500');
      assert.equal(run.rows[0].coverage_complete, false);
    });
  },
);

test(
  'the coverage cursor is a single upserted row that survives repeated runs',
  { timeout: 180000, skip: !dockerAvailable },
  async () => {
    await withMigratedDatabase(async (pool) => {
      const upsert = `
        INSERT INTO reconcile_cursors (
          scope, last_trade_id, boundary_block_number, boundary_block_hash, tail_first_seen_at, updated_at
        ) VALUES ($1, $2::numeric, $3, $4, $5, NOW())
        ON CONFLICT (scope) DO UPDATE SET
          last_trade_id = EXCLUDED.last_trade_id,
          boundary_block_number = EXCLUDED.boundary_block_number,
          boundary_block_hash = EXCLUDED.boundary_block_hash,
          tail_first_seen_at = EXCLUDED.tail_first_seen_at,
          updated_at = NOW()`;

      await pool.query(upsert, ['trades', '1000', 1000, '0xaaa', new Date()]);
      await pool.query(upsert, ['trades', '2000', 1100, '0xbbb', null]);

      const rows = await pool.query(
        `SELECT last_trade_id::text AS last_trade_id, boundary_block_number::text AS block, tail_first_seen_at
         FROM reconcile_cursors WHERE scope = 'trades'`,
      );
      assert.equal(rows.rows.length, 1, 'the cursor must stay a single row per scope');
      assert.equal(rows.rows[0].last_trade_id, '2000');
      assert.equal(rows.rows[0].block, '1100');
      assert.equal(rows.rows[0].tail_first_seen_at, null);

      // Trade ids are unsigned; a negative cursor would silently re-sweep.
      await assert.rejects(
        () => pool.query(upsert, ['trades', '-1', 1, '0xccc', null]),
        /ck_reconcile_cursors_trade_id_non_negative/,
      );
    });
  },
);

test(
  'the cursor table is service-isolated like every other reconcile table',
  { timeout: 180000, skip: !dockerAvailable },
  async () => {
    await withMigratedDatabase(async (pool) => {
      const policy = await pool.query(
        `SELECT policyname FROM pg_policies
         WHERE tablename = 'reconcile_cursors'`,
      );
      assert.deepEqual(
        policy.rows.map((row) => row.policyname),
        ['reconcile_cursors_service_isolation'],
      );

      const rls = await pool.query(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = 'reconcile_cursors'`,
      );
      assert.equal(rls.rows[0].relrowsecurity, true);
      assert.equal(rls.rows[0].relforcerowsecurity, true);
    });
  },
);
