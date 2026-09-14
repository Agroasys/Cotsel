// Must come first: the database modules below load src/config.ts on import,
// which asserts a complete configuration before any test body runs.
import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMigrationHistory } from '@agroasys/shared-db/migrate';
import {
  LeaseLostError,
  appendLeaseEvent,
  assertLeaseHeld,
  heartbeatLease,
  markAbandonedRuns,
  releaseLease,
} from '../database/leases';
import { failRun, finalizeRun } from '../database/queries';
import {
  TTL_MS,
  type AdminPool,
  claim,
  claimOrThrow,
  createAdminPool,
  dockerAvailable,
  expireLease,
  leaseEvents,
  readRun,
  RUNTIME_ROLE,
  MANIFEST_PATH,
  scenarioRunner,
  stats,
  withPostgresContainer,
} from './helpers/reconciliationPostgres';
import type { RunLeaseIdentity } from '../types';

test(
  'reconciliation run leases (H-17)',
  { timeout: 300_000, skip: !dockerAvailable },
  async (t) => {
    await withPostgresContainer(async ({ port }: { port: number }) => {
      const admin: AdminPool = await createAdminPool(port);
      try {
        await admin.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
        const scenario = scenarioRunner(t, port, admin, 'leases');

        await scenario('the migration chain applies and matches its fingerprints', async (pool) => {
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
              ['202609120001', 'run_leases'],
            ],
          );
        });

        await scenario('a fresh run key is claimed already leased', async (pool) => {
          const run = await claimOrThrow(pool, 'worker-a');

          assert.equal(run.lease.epoch, 1);
          assert.equal(run.takeoverFrom, null);
          assert.equal(run.row.status, 'RUNNING');
          assert.equal(run.row.lease_owner, 'worker-a');
          assert.ok(run.row.lease_expires_at instanceof Date);
          assert.deepEqual(await leaseEvents(pool, 'daemon-1'), ['ACQUIRED']);
        });

        await scenario('a live lease keeps a second worker out', async (pool) => {
          await claimOrThrow(pool, 'worker-a');

          const second = await claim(pool, 'worker-b');
          assert.equal(second.claimed, false);
          if (second.claimed) {
            return;
          }
          assert.equal(second.refusal, 'LEASE_HELD');
          assert.equal(second.row.lease_owner, 'worker-a');
        });

        await scenario('a completed run key is never reclaimed', async (pool) => {
          const run = await claimOrThrow(pool, 'worker-a');
          await finalizeRun(
            {
              stats: stats('daemon-1'),
              lease: run.lease,
              cursor: { advance: false, tailFirstSeenAt: null },
            },
            pool,
          );

          // Even with the lease long gone, a completed window must not be
          // redone under the same key and republished.
          await expireLease(pool, 'daemon-1');
          const second = await claim(pool, 'worker-b');

          assert.equal(second.claimed, false);
          if (second.claimed) {
            return;
          }
          assert.equal(second.refusal, 'ALREADY_COMPLETED');
        });

        await scenario('lease expiry marks the run abandoned and names the owner', async (pool) => {
          await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');

          const abandoned = await markAbandonedRuns(TTL_MS, pool);

          assert.equal(abandoned.length, 1);
          assert.equal(abandoned[0].runKey, 'daemon-1');
          assert.equal(abandoned[0].owner, 'worker-a');
          assert.ok(abandoned[0].leaseExpiresAt instanceof Date);

          const row = await readRun(pool, 'daemon-1');
          assert.equal(row.status, 'ABANDONED');
          assert.equal(row.abandoned_owner, 'worker-a');
          assert.equal(row.lease_owner, null);
          assert.ok(row.abandoned_at instanceof Date);
          assert.deepEqual(await leaseEvents(pool, 'daemon-1'), ['ACQUIRED', 'ABANDONED']);
        });

        await scenario('a live run is never swept', async (pool) => {
          await claimOrThrow(pool, 'worker-a');

          assert.deepEqual(await markAbandonedRuns(TTL_MS, pool), []);
          assert.equal((await readRun(pool, 'daemon-1')).status, 'RUNNING');
        });

        await scenario('a pre-lease RUNNING row is swept after a TTL of grace', async (pool) => {
          // Exactly the shape this control exists to repair: a row with no
          // lease at all, which every previous build would skip forever.
          await pool.query(
            `INSERT INTO reconcile_runs (run_key, mode, status, started_at)
             VALUES ('legacy-1', 'DAEMON', 'RUNNING', NOW() - INTERVAL '2 hours')`,
          );

          const abandoned = await markAbandonedRuns(TTL_MS, pool);

          assert.equal(abandoned.length, 1);
          assert.equal(abandoned[0].runKey, 'legacy-1');
          assert.equal(abandoned[0].owner, null);
          assert.equal((await readRun(pool, 'legacy-1')).status, 'ABANDONED');
        });

        await scenario('a pre-lease row inside its grace window is left alone', async (pool) => {
          await pool.query(
            `INSERT INTO reconcile_runs (run_key, mode, status, started_at)
             VALUES ('legacy-1', 'DAEMON', 'RUNNING', NOW())`,
          );

          assert.deepEqual(await markAbandonedRuns(TTL_MS, pool), []);
        });

        await scenario('exactly one successor claims an abandoned run', async (pool) => {
          await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');
          await markAbandonedRuns(TTL_MS, pool);

          const claims = await Promise.all(
            ['worker-b', 'worker-c', 'worker-d', 'worker-e'].map((owner) => claim(pool, owner)),
          );

          const winners = claims.filter((result) => result.claimed);
          assert.equal(winners.length, 1, 'exactly one successor must win the abandoned run');

          const row = await readRun(pool, 'daemon-1');
          assert.equal(row.status, 'RUNNING');
          assert.equal(row.lease_epoch, 2);
          assert.equal(row.takeover_count, 1);
          assert.equal(row.abandoned_owner, 'worker-a');
          assert.deepEqual(await leaseEvents(pool, 'daemon-1'), [
            'ACQUIRED',
            'ABANDONED',
            'RECLAIMED',
          ]);
        });

        await scenario('an expired lease is taken over before the sweep notices', async (pool) => {
          await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');

          const successor = await claimOrThrow(pool, 'worker-b');

          // The displaced owner must still be recoverable with no sweep run.
          assert.equal(successor.takeoverFrom, 'worker-a');
          assert.equal(successor.lease.epoch, 2);
          assert.ok((await readRun(pool, 'daemon-1')).abandoned_at instanceof Date);
        });

        await scenario('a displaced worker cannot heartbeat', async (pool) => {
          const first = await claimOrThrow(pool, 'worker-a');
          assert.equal(await heartbeatLease(first.lease, TTL_MS, pool), true);

          await expireLease(pool, 'daemon-1');
          await claimOrThrow(pool, 'worker-b');

          assert.equal(await heartbeatLease(first.lease, TTL_MS, pool), false);
        });

        await scenario('a displaced worker publishes nothing and moves no cursor', async (pool) => {
          const first = await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');
          await claimOrThrow(pool, 'worker-b');

          await assert.rejects(
            finalizeRun(
              {
                stats: stats('daemon-1'),
                lease: first.lease,
                cursor: {
                  advance: true,
                  lastTradeId: 999n,
                  boundaryBlockNumber: 500,
                  boundaryBlockHash: '0xdead',
                  tailFirstSeenAt: null,
                },
              },
              pool,
            ),
            LeaseLostError,
          );

          // The whole transaction rolled back: the successor's run row is
          // intact and the cursor never moved.
          const row = await readRun(pool, 'daemon-1');
          assert.equal(row.status, 'RUNNING');
          assert.equal(row.lease_owner, 'worker-b');

          const cursor = await pool.query('SELECT * FROM reconcile_cursors');
          assert.equal(cursor.rowCount, 0, 'a displaced run must not advance the cursor');
        });

        await scenario('a displaced worker cannot stamp its run FAILED', async (pool) => {
          const first = await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');
          await claimOrThrow(pool, 'worker-b');

          assert.equal(await failRun(first.lease, 'rpc exploded', pool), false);

          const row = await readRun(pool, 'daemon-1');
          assert.equal(row.status, 'RUNNING');
          assert.equal(row.error_message, null);
        });

        await scenario('the successor completes the reclaimed run unaided', async (pool) => {
          await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');
          await markAbandonedRuns(TTL_MS, pool);

          const successor = await claimOrThrow(pool, 'worker-b');
          await finalizeRun(
            {
              stats: stats('daemon-1'),
              lease: successor.lease,
              cursor: {
                advance: true,
                lastTradeId: 42n,
                boundaryBlockNumber: 500,
                boundaryBlockHash: '0xfeed',
                tailFirstSeenAt: null,
              },
            },
            pool,
          );

          const row = await readRun(pool, 'daemon-1');
          assert.equal(row.status, 'COMPLETED');
          assert.equal(row.total_trades, 3);
          // Terminal runs hand the lease back rather than making the next
          // worker wait out a TTL.
          assert.equal(row.lease_owner, null);

          const cursor = await pool.query<{ last_trade_id: string }>(
            'SELECT last_trade_id::text FROM reconcile_cursors',
          );
          assert.equal(cursor.rows[0].last_trade_id, '42');
        });

        await scenario('a failing run frees its key immediately for a retry', async (pool) => {
          const first = await claimOrThrow(pool, 'worker-a', 'once-1');
          assert.equal(await failRun(first.lease, 'indexer unreachable', pool), true);

          // A FAILED run is not a wedged one: the operator can rerun the same
          // key straight away rather than waiting out the lease.
          const retry = await claimOrThrow(pool, 'worker-b', 'once-1');
          assert.equal(retry.row.error_message, null);
        });

        await scenario('a still-running run cannot be un-leased', async (pool) => {
          const first = await claimOrThrow(pool, 'worker-a');

          // Releasing here would leave a row that reads unowned while a worker
          // is still writing it, and a second worker could pick it up after the
          // grace window and redo the same window concurrently.
          assert.equal(await releaseLease(first.lease, pool), false);
          assert.equal((await readRun(pool, 'daemon-1')).lease_owner, 'worker-a');
          assert.equal((await claim(pool, 'worker-b')).claimed, false);
        });

        await scenario('a skipped run hands its key straight back', async (pool) => {
          const first = await claimOrThrow(pool, 'worker-a');

          // An inconclusive run finalizes as SKIPPED, which releases the lease
          // inside the same transaction. The key must be free at once.
          await finalizeRun(
            {
              stats: stats('daemon-1', 'SKIPPED'),
              lease: first.lease,
              cursor: { advance: false, tailFirstSeenAt: null },
            },
            pool,
          );

          assert.equal((await readRun(pool, 'daemon-1')).lease_owner, null);

          const second = await claimOrThrow(pool, 'worker-b');
          assert.equal(second.lease.epoch, 2);
        });

        await scenario('the lease log keeps every abandonment, not just the last', async (pool) => {
          for (const owner of ['worker-a', 'worker-b']) {
            await claimOrThrow(pool, owner);
            await expireLease(pool, 'daemon-1');
            await markAbandonedRuns(TTL_MS, pool);
          }

          assert.deepEqual(await leaseEvents(pool, 'daemon-1'), [
            'ACQUIRED',
            'ABANDONED',
            'RECLAIMED',
            'ABANDONED',
          ]);

          const owners = await pool.query<{ previous_owner: string | null }>(
            `SELECT previous_owner FROM reconcile_run_lease_events
             WHERE run_key = $1 AND event = 'ABANDONED' ORDER BY id`,
            ['daemon-1'],
          );
          assert.deepEqual(
            owners.rows.map((row) => row.previous_owner),
            ['worker-a', 'worker-b'],
          );
        });

        await scenario('an expired lease cannot be beaten back to life', async (pool) => {
          // The window this closes: the lease has lapsed but the sweeper has not
          // run yet, so the row still names this owner and epoch. A worker back
          // from a long stall must find its lease gone, not renewable — by now
          // the key is open to any successor.
          const run = await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');

          assert.equal(await heartbeatLease(run.lease, TTL_MS, pool), false);

          const stillExpired = await readRun(pool, 'daemon-1');
          assert.equal(stillExpired.status, 'RUNNING');
          assert.ok((stillExpired.lease_expires_at as Date) <= new Date());
        });

        await scenario('an expired lease fails the finalize fence', async (pool) => {
          const run = await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await assert.rejects(assertLeaseHeld(client, run.lease), LeaseLostError);
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }

          await assert.rejects(
            finalizeRun(
              {
                stats: stats('daemon-1'),
                lease: run.lease,
                cursor: { advance: false, tailFirstSeenAt: null },
              },
              pool,
            ),
            LeaseLostError,
          );
          assert.equal((await readRun(pool, 'daemon-1')).status, 'RUNNING');
        });

        await scenario('an expired lease cannot stamp FAILED over its own key', async (pool) => {
          // The row stays RUNNING so the sweeper records what actually happened
          // — abandoned — rather than a failure reported by a worker that had
          // already lost the key.
          const run = await claimOrThrow(pool, 'worker-a');
          await expireLease(pool, 'daemon-1');

          assert.equal(await failRun(run.lease, 'boom', pool), false);
          assert.equal((await readRun(pool, 'daemon-1')).status, 'RUNNING');
        });

        await scenario('a held lease passes the finalize fence', async (pool) => {
          const run = await claimOrThrow(pool, 'worker-a');

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await assertLeaseHeld(client, run.lease);
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        });

        await scenario('an unknown lease fails the fence', async (pool) => {
          await claimOrThrow(pool, 'worker-a');

          const impostor: RunLeaseIdentity = { runKey: 'daemon-1', owner: 'worker-z', epoch: 7 };
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await assert.rejects(assertLeaseHeld(client, impostor), LeaseLostError);
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        });

        await scenario('a lease event records the detail it was given', async (pool) => {
          const run = await claimOrThrow(pool, 'worker-a');

          await appendLeaseEvent(
            {
              runId: run.row.id,
              runKey: 'daemon-1',
              event: 'LOST',
              owner: 'worker-a',
              epoch: 1,
              detail: { reason: 'heartbeat rejected' },
            },
            pool,
          );

          const events = await pool.query<{ detail: Record<string, unknown> }>(
            `SELECT detail FROM reconcile_run_lease_events WHERE run_key = $1 AND event = 'LOST'`,
            ['daemon-1'],
          );
          assert.deepEqual(events.rows[0].detail, { reason: 'heartbeat rejected' });
        });
      } finally {
        await admin.end();
      }
    });
  },
);
