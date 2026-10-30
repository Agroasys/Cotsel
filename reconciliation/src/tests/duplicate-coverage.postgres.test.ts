import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';

/* eslint-disable @typescript-eslint/no-require-imports */
const { dockerAvailable, withPostgresContainer } =
  require('../../../shared-db/postgres-test-support') as {
    dockerAvailable: boolean;
    withPostgresContainer: (fn: (value: { port: number }) => Promise<void>) => Promise<void>;
  };
/* eslint-enable @typescript-eslint/no-require-imports */
const useLocal = process.env.RECONCILIATION_LOCAL_POSTGRES_TESTS === 'true';

test(
  'the reconciliation run records duplicate coverage and holds its cursor',
  {
    skip: !useLocal && !dockerAvailable,
    timeout: 60000,
  },
  async (t) => {
    const run = async (port: number): Promise<void> => {
      const database = `recon_duplicate_${randomBytes(6).toString('hex')}`;
      const connection = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres' };
      const admin = new Pool({ ...connection, database: 'postgres' });
      let pool: Pool | undefined;
      let closeService: (() => Promise<void>) | undefined;
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        pool = new Pool({
          ...connection,
          database,
          options: '-c app.service_name=reconciliation -c app.runtime_db_user=postgres',
        });
        await runVersionedMigrations({
          pool,
          serviceName: 'reconciliation',
          manifestPath: path.resolve(__dirname, '../database/migrations.json'),
          runtimeDbUser: 'postgres',
        });
        process.env.DB_NAME = database;
        process.env.DB_PORT = String(port);
        const { closeConnection } = await import('../database/connection');
        closeService = closeConnection;
        const { advanceCoverageCursor } = await import('../database/queries');
        await advanceCoverageCursor(
          {
            lastTradeId: 7n,
            boundaryBlockNumber: 4000,
            boundaryBlockHash: 'anchor',
            tailFirstSeenAt: null,
          },
          pool,
        );
        const { OnchainClient } = await import('../blockchain/client');
        const { IndexerClient } = await import('../indexer/client');
        t.mock.method(OnchainClient.prototype, 'resolveBoundary', async () => ({
          blockNumber: 4242,
          blockHash: '0xboundary',
          tag: 'finalized' as const,
          chainTradeCounter: 7n,
          indexerProcessedBlock: 4242,
          finalityBlockNumber: 4242,
          indexerAhead: false,
        }));
        t.mock.method(IndexerClient.prototype, 'fetchProcessedBlock', async () => 4242);
        t.mock.method(IndexerClient.prototype, 'fetchTradeIds', async () => ({
          tradeIds: ['0', '0', '2'],
          truncated: false,
        }));
        t.mock.method(IndexerClient.prototype, 'fetchTradeCount', async () => 3);
        const { ReconciliationService } = await import('../core/reconciler');
        const result = await new ReconciliationService().reconcileOnce('ONCE', 'duplicate-test');
        assert.equal(result.status, 'COMPLETED');
        assert.equal(result.driftCount, 1);
        assert.equal(result.coverage?.cursorAdvanced, false);
        assert.equal(result.coverage?.complete, false);
        const drifts = await pool.query(
          'SELECT trade_id, mismatch_code, severity FROM reconcile_drifts',
        );
        assert.deepEqual(drifts.rows, [
          { trade_id: '0', mismatch_code: 'INDEXER_DUPLICATE_TRADE', severity: 'CRITICAL' },
        ]);
        const alerts = await pool.query('SELECT kind, payload FROM reconcile_alert_outbox');
        assert.equal(alerts.rows.length, 1);
        assert.equal(alerts.rows[0].kind, 'CRITICAL_DRIFT');
        assert.equal(alerts.rows[0].payload.finding.mismatchCode, 'INDEXER_DUPLICATE_TRADE');
        const cursor = await pool.query('SELECT last_trade_id FROM reconcile_cursors');
        assert.equal(cursor.rows.length, 1);
        assert.equal(cursor.rows[0].last_trade_id, '7');
        const runs = await pool.query('SELECT coverage_complete FROM reconcile_runs');
        assert.equal(runs.rows[0].coverage_complete, false);
      } finally {
        await closeService?.();
        await pool?.end();
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.end();
      }
    };
    if (useLocal) await run(5432);
    else await withPostgresContainer(async ({ port }) => run(port));
  },
);
