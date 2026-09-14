// Must come first: the database modules below load src/config.ts on import,
// which asserts a complete configuration before any test body runs.
import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LeaseLostError } from '../database/leases';
import { finalizeRun } from '../database/queries';
import {
  ReplayedApprovalError,
  getContainment,
  listBlockingContainments,
  openContainment,
  recordCleanReconciliation,
  recordPauseObservation,
  releaseContainment,
} from '../database/containments';
import { readPendingRunAlerts } from '../database/alertOutbox';
import { applyContainment, publishFinding } from '../core/runControls';
import { qualifyDiscrepancies } from '../core/containment';
import {
  type AdminPool,
  BOUNDARY,
  amountDrift,
  approval,
  claimOrThrow,
  createAdminPool,
  dockerAvailable,
  expireLease,
  openIncident,
  pausedAt,
  readRun,
  readyForRelease,
  RUNTIME_ROLE,
  scenarioRunner,
  stats,
  withPostgresContainer,
} from './helpers/reconciliationPostgres';

test(
  'scoped discrepancy containment (PRES-11)',
  { timeout: 300_000, skip: !dockerAvailable },
  async (t) => {
    await withPostgresContainer(async ({ port }: { port: number }) => {
      const admin: AdminPool = await createAdminPool(port);
      try {
        await admin.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
        const scenario = scenarioRunner(t, port, admin, 'containment');

        await scenario('a qualified discrepancy contains only the affected trade', async (pool) => {
          const { row, opened } = await openIncident(pool);

          assert.equal(opened, true);
          assert.equal(row.state, 'CONTAINED');
          assert.equal(row.observation_count, 1);
          assert.deepEqual(row.qualifying_codes, ['AMOUNT_MISMATCH']);

          assert.deepEqual(
            (await listBlockingContainments(pool)).map((entry) => entry.trade_id),
            ['7'],
          );
        });

        await scenario('a repeat sighting folds into the standing incident', async (pool) => {
          const first = await openIncident(pool, 'daemon-1');
          const second = await openIncident(pool, 'daemon-2', ['HASH_MISMATCH']);

          assert.equal(second.opened, false);
          // An operator quoting the original reference must keep reaching the
          // same incident.
          assert.equal(second.row.incident_reference, first.row.incident_reference);
          assert.equal(second.row.observation_count, 2);
          assert.deepEqual(second.row.qualifying_codes, ['AMOUNT_MISMATCH', 'HASH_MISMATCH']);
          assert.equal(second.row.opened_run_key, 'daemon-1');
          assert.equal(second.row.last_observed_run_key, 'daemon-2');
          assert.equal((await listBlockingContainments(pool)).length, 1);
        });

        await scenario('the run that opened an incident cannot clear it', async (pool) => {
          await openIncident(pool, 'daemon-1');

          assert.equal(
            await recordCleanReconciliation({ tradeId: '7', runKey: 'daemon-1' }, pool),
            null,
          );
          assert.equal((await getContainment('7', pool))?.state, 'CONTAINED');
        });

        await scenario('a clean reconciliation does not release a trade', async (pool) => {
          await openIncident(pool, 'daemon-1');

          const cleared = await recordCleanReconciliation(
            { tradeId: '7', runKey: 'daemon-2' },
            pool,
          );
          assert.equal(cleared?.state, 'RECONCILED_PENDING_APPROVAL');
          assert.equal(cleared?.cleared_run_key, 'daemon-2');

          // Still blocked: evidence is not authority.
          assert.equal((await listBlockingContainments(pool)).length, 1);
        });

        await scenario('release needs a fresh clean run and a governed approval', async (pool) => {
          await openIncident(pool, 'daemon-1');
          await recordPauseObservation(pausedAt('7'), pool);

          // Approval alone, while the trade is still diverging, releases nothing.
          assert.equal(
            await releaseContainment({ tradeId: '7', evidence: approval() }, pool),
            null,
          );

          await recordCleanReconciliation({ tradeId: '7', runKey: 'daemon-2' }, pool);

          const released = await releaseContainment({ tradeId: '7', evidence: approval() }, pool);
          assert.equal(released?.state, 'RELEASED');
          assert.equal(released?.approval_tx_hash, approval().txHash);
          assert.equal(released?.approval_chain_id, '84532');
          assert.equal(released?.approval_count, 2);
          assert.deepEqual(released?.approval_approvers, [
            '0x1111111111111111111111111111111111111111',
          ]);
          assert.deepEqual(await listBlockingContainments(pool), []);
        });

        await scenario('a trade never seen paused cannot be released', async (pool) => {
          // Releasing here would record a recovery from a containment the
          // escrow never enforced.
          await openIncident(pool, 'daemon-1');
          await recordCleanReconciliation({ tradeId: '7', runKey: 'daemon-2' }, pool);

          assert.equal(
            await releaseContainment({ tradeId: '7', evidence: approval() }, pool),
            null,
          );
          assert.equal((await getContainment('7', pool))?.state, 'RECONCILED_PENDING_APPROVAL');
        });

        await scenario('a failed pause read is not evidence of a pause', async (pool) => {
          await openIncident(pool, 'daemon-1');
          await recordPauseObservation(
            { tradeId: '7', paused: false, blockNumber: 4242, readError: 'rpc timeout' },
            pool,
          );

          const row = await getContainment('7', pool);
          // Checked, and found wanting: the check is recorded, the pause is not.
          assert.ok(row?.pause_last_checked_at instanceof Date);
          assert.equal(row?.pause_observed_at, null);
          assert.equal(row?.pause_observed_block, null);
        });

        await scenario('one governed unpause cannot release two trades', async (pool) => {
          await readyForRelease(pool);
          await releaseContainment({ tradeId: '7', evidence: approval() }, pool);

          await openContainment(
            {
              tradeId: '8',
              incidentReference: 'RECON-20260913-OTHER',
              runKey: 'daemon-1',
              qualifyingCodes: ['AMOUNT_MISMATCH'],
              evidence: {},
            },
            pool,
          );
          await recordPauseObservation(pausedAt('8'), pool);
          await recordCleanReconciliation({ tradeId: '8', runKey: 'daemon-2' }, pool);

          await assert.rejects(
            releaseContainment({ tradeId: '8', evidence: approval({ tradeId: '8' }) }, pool),
            ReplayedApprovalError,
          );
          assert.equal((await getContainment('8', pool))?.state, 'RECONCILED_PENDING_APPROVAL');
        });

        await scenario('a returning divergence re-contains a trade', async (pool) => {
          await readyForRelease(pool);

          const again = await openIncident(pool, 'daemon-3');

          assert.equal(again.row.state, 'CONTAINED');
          // The clearance evidence is dropped, so a pending approval cannot be
          // spent on a divergence that came back.
          assert.equal(again.row.cleared_run_key, null);
          assert.equal(again.row.cleared_at, null);
          // So is the pause observation: the previous incident's pause was
          // lifted, and this one has not been enforced on chain yet.
          assert.equal(again.row.pause_observed_at, null);
          assert.equal(
            await releaseContainment({ tradeId: '7', evidence: approval() }, pool),
            null,
          );
        });

        await scenario(
          'a released trade cannot be re-released on the same receipt',
          async (pool) => {
            // The full round trip: contained, released, diverging again, cleared
            // again — and the original approval is spent.
            await readyForRelease(pool);
            await releaseContainment({ tradeId: '7', evidence: approval() }, pool);

            await openIncident(pool, 'daemon-3');
            await recordPauseObservation(pausedAt('7'), pool);
            await recordCleanReconciliation({ tradeId: '7', runKey: 'daemon-4' }, pool);

            await assert.rejects(
              releaseContainment({ tradeId: '7', evidence: approval() }, pool),
              ReplayedApprovalError,
            );
          },
        );

        await scenario(
          'a release without on-chain evidence is rejected by the schema',
          async (pool) => {
            await readyForRelease(pool);

            await assert.rejects(
              pool.query(
                `UPDATE reconcile_trade_containments SET state = 'RELEASED' WHERE trade_id = '7'`,
              ),
              /ck_reconcile_trade_containments_release_evidence/u,
            );
          },
        );

        await scenario('a takeover during publication publishes nothing', async (pool) => {
          // The gap this closes: a run that finished its last batch used to
          // write its drift, trade scope and containment — and send its alerts —
          // before the fence was ever consulted, so a worker displaced after
          // that last batch published stale evidence about a window its
          // successor was already redoing. The fence rejected the run, but only
          // after the damage was committed. All of it now rides the fenced
          // transaction, so a displaced worker writes nothing at all.
          const run = await claimOrThrow(pool, 'worker-a');
          const runStats = stats('daemon-1');
          const finding = amountDrift('7');

          // The successor takes the key over while the displaced worker is
          // still between its last batch and finalization.
          await expireLease(pool, 'daemon-1');
          const successor = await claimOrThrow(pool, 'worker-b');
          assert.equal(successor.takeoverFrom, 'worker-a');

          let published = false;
          await assert.rejects(
            finalizeRun(
              {
                stats: runStats,
                lease: run.lease,
                publish: async (client) => {
                  published = true;
                  await publishFinding(
                    { runId: run.row.id, runKey: 'daemon-1', finding, stats: runStats },
                    client,
                  );
                  await applyContainment(
                    {
                      runId: run.row.id,
                      runKey: 'daemon-1',
                      boundary: BOUNDARY,
                      qualified: qualifyDiscrepancies([finding]),
                      cleanTradeIds: new Set<string>(),
                      pauseObservations: new Map([['7', pausedAt('7')]]),
                    },
                    client,
                  );
                },
                cursor: { advance: false, tailFirstSeenAt: null },
              },
              pool,
            ),
            LeaseLostError,
          );

          // The fence is the first statement, so the publication never starts;
          // nothing is written, and nobody is paged about evidence that does
          // not exist.
          assert.equal(published, false);
          assert.equal((await pool.query('SELECT 1 FROM reconcile_drifts')).rowCount, 0);
          assert.equal((await pool.query('SELECT 1 FROM reconcile_run_trades')).rowCount, 0);
          assert.deepEqual(await listBlockingContainments(pool), []);
          assert.deepEqual(await readPendingRunAlerts(50, pool), []);
          // The successor still owns the key.
          assert.equal((await readRun(pool, 'daemon-1')).lease_owner, 'worker-b');
        });

        await scenario('a publication that throws mid-way commits none of itself', async (pool) => {
          // The other half of "all or nothing": the containments and alerts a
          // run opened must not survive a failure later in the same publication.
          const run = await claimOrThrow(pool, 'worker-a');
          const runStats = stats('daemon-1');
          const finding = amountDrift('7');

          await assert.rejects(
            finalizeRun(
              {
                stats: runStats,
                lease: run.lease,
                publish: async (client) => {
                  await applyContainment(
                    {
                      runId: run.row.id,
                      runKey: 'daemon-1',
                      boundary: BOUNDARY,
                      qualified: qualifyDiscrepancies([finding]),
                      cleanTradeIds: new Set<string>(),
                      pauseObservations: new Map([['7', pausedAt('7')]]),
                    },
                    client,
                  );
                  throw new Error('indexer went away mid-publication');
                },
                cursor: { advance: false, tailFirstSeenAt: null },
              },
              pool,
            ),
            /indexer went away mid-publication/u,
          );

          assert.deepEqual(await listBlockingContainments(pool), []);
          assert.deepEqual(await readPendingRunAlerts(50, pool), []);
          assert.equal((await readRun(pool, 'daemon-1')).status, 'RUNNING');
        });

        await scenario(
          'a fenced run commits its findings, containment and alerts together',
          async (pool) => {
            const run = await claimOrThrow(pool, 'worker-a');
            const runStats = stats('daemon-1');
            const finding = amountDrift('7');

            await finalizeRun(
              {
                stats: runStats,
                lease: run.lease,
                publish: async (client) => {
                  await publishFinding(
                    { runId: run.row.id, runKey: 'daemon-1', finding, stats: runStats },
                    client,
                  );
                  await applyContainment(
                    {
                      runId: run.row.id,
                      runKey: 'daemon-1',
                      boundary: BOUNDARY,
                      qualified: qualifyDiscrepancies([finding]),
                      cleanTradeIds: new Set<string>(),
                      pauseObservations: new Map([['7', pausedAt('7')]]),
                    },
                    client,
                  );
                },
                cursor: { advance: false, tailFirstSeenAt: null },
              },
              pool,
            );

            assert.equal((await readRun(pool, 'daemon-1')).status, 'COMPLETED');
            assert.deepEqual(
              (await listBlockingContainments(pool)).map((row) => row.trade_id),
              ['7'],
            );
            // The pause was observed, so no escalation is owed — only the drift
            // and the containment itself.
            assert.deepEqual((await readPendingRunAlerts(50, pool)).map((row) => row.kind).sort(), [
              'CRITICAL_DRIFT',
              'TRADE_CONTAINED',
            ]);
            assert.ok((await getContainment('7', pool))?.pause_observed_at instanceof Date);
          },
        );

        await scenario('a containment with no on-chain pause escalates', async (pool) => {
          const run = await claimOrThrow(pool, 'worker-a');
          const runStats = stats('daemon-1');
          const finding = amountDrift('7');

          await finalizeRun(
            {
              stats: runStats,
              lease: run.lease,
              publish: async (client) => {
                await applyContainment(
                  {
                    runId: run.row.id,
                    runKey: 'daemon-1',
                    boundary: BOUNDARY,
                    qualified: qualifyDiscrepancies([finding]),
                    cleanTradeIds: new Set<string>(),
                    pauseObservations: new Map([['7', pausedAt('7', false)]]),
                  },
                  client,
                );
              },
              cursor: { advance: false, tailFirstSeenAt: null },
            },
            pool,
          );

          assert.deepEqual((await readPendingRunAlerts(50, pool)).map((row) => row.kind).sort(), [
            'TRADE_CONTAINED',
            'TRADE_PAUSE_UNCONFIRMED',
          ]);
          // Still contained, and still blocking, whether or not the pause landed.
          assert.equal((await listBlockingContainments(pool)).length, 1);
        });

        await scenario('an inconclusive trade does not clear a containment', async (pool) => {
          // A trade in a run's scope whose chain read failed is not evidence of
          // anything, so it cannot supply the clean reconciliation a release
          // needs — even though the run did cover it.
          await openIncident(pool, 'daemon-1');

          const run = await claimOrThrow(pool, 'worker-a', 'daemon-2');
          const runStats = stats('daemon-2');

          await finalizeRun(
            {
              stats: runStats,
              lease: run.lease,
              publish: async (client) => {
                await applyContainment(
                  {
                    runId: run.row.id,
                    runKey: 'daemon-2',
                    boundary: BOUNDARY,
                    qualified: [],
                    // Trade 7 was looked at, but the look failed, so it is not
                    // in the clean set.
                    cleanTradeIds: new Set(['9']),
                    pauseObservations: new Map(),
                  },
                  client,
                );
              },
              cursor: { advance: false, tailFirstSeenAt: null },
            },
            pool,
          );

          assert.equal((await getContainment('7', pool))?.state, 'CONTAINED');
        });

        await scenario('the containment state machine rejects an unknown state', async (pool) => {
          await assert.rejects(
            pool.query(
              `INSERT INTO reconcile_trade_containments (trade_id, incident_reference, state, opened_run_key)
               VALUES ('7', 'RECON-1', 'RESUMED', 'daemon-1')`,
            ),
            /ck_reconcile_trade_containments_state/u,
          );
        });
      } finally {
        await admin.end();
      }
    });
  },
);
