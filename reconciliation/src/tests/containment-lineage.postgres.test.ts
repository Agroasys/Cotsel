// Must come first: the database modules below load src/config.ts on import,
// and the config needs a valid environment before that happens.
import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  findingDigest,
  parsePublicKeys,
  type RunManifest,
} from '@agroasys/shared-db/reconciliationEvidence';
import {
  loadContainmentRecoveryBundle,
  verifyContainmentRecovery,
} from '@agroasys/shared-db/containmentRecovery';
import {
  openContainment,
  getContainment,
  recordCleanReconciliation,
  recordPauseObservation,
  releaseContainment,
} from '../database/containments';
import { finalizeRun, upsertDrift, upsertRunTradeScope } from '../database/queries';
import { createLocalFindingSigner, localPublicKeyDerBase64 } from '../core/findingSigner';
import type { DriftFinding } from '../types';
import { BASE_TEST_ENV } from './helpers/reconciliationEnv';
import {
  approval,
  claimOrThrow,
  createAdminPool,
  dockerAvailable,
  pausedAt,
  RUNTIME_ROLE,
  scenarioRunner,
  stats,
  withPostgresContainer,
  type AdminPool,
} from './helpers/reconciliationPostgres';

// Review R01 / R03: the incident keeps every finding it cites with the signed
// run it came from, a released trade that diverges again is a new incident,
// and each sealed run signs the containment state and its clearances.
const SIGNER = createLocalFindingSigner(
  'reconciliation-test-key',
  BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY,
);

const drift = (indexedValue: string): DriftFinding => ({
  tradeId: '7',
  severity: 'CRITICAL',
  mismatchCode: 'AMOUNT_MISMATCH',
  comparedField: 'totalAmountLocked',
  onchainValue: '100',
  indexedValue,
  details: {},
});

/** One run that publishes `findings` for trade 7 (and opens or folds its incident). */
async function divergingRun(pool: Pool, runKey: string, finding: DriftFinding) {
  const run = await claimOrThrow(pool, `worker-${runKey}`, runKey);
  await finalizeRun(
    {
      stats: { ...stats(runKey), driftCount: 1 },
      lease: run.lease,
      publish: async (client) => {
        await upsertRunTradeScope(run.row.id, runKey, '7', client);
        await upsertDrift(run.row.id, runKey, finding, client);
        await openContainment(
          {
            tradeId: '7',
            incidentReference: `RECON-20261124-${runKey.replace(/[^0-9a-z]/giu, '').toUpperCase()}`,
            runKey,
            qualifyingCodes: ['AMOUNT_MISMATCH'],
            evidence: { runKey, findings: [{ digest: findingDigest({ runKey, ...finding }) }] },
          },
          client,
        );
      },
      cursor: { advance: false, tailFirstSeenAt: null },
    },
    pool,
    SIGNER,
  );
}

/** One run in which trade 7 is in scope and reconciles clean. */
async function cleanRun(pool: Pool, runKey: string, retainedFinding?: DriftFinding) {
  const run = await claimOrThrow(pool, `worker-${runKey}`, runKey);
  await finalizeRun(
    {
      stats: stats(runKey),
      lease: run.lease,
      publish: async (client) => {
        await upsertRunTradeScope(run.row.id, runKey, '7', client);
        await recordCleanReconciliation({ tradeId: '7', runKey }, client);
        // Reproduce the old publication order: copied evidence followed clearance.
        if (retainedFinding) await upsertDrift(run.row.id, runKey, retainedFinding, client);
      },
      cursor: { advance: false, tailFirstSeenAt: null },
    },
    pool,
    SIGNER,
  );
}

async function manifestOf(pool: Pool, runKey: string): Promise<RunManifest> {
  const result = await pool.query<{ manifest: RunManifest }>(
    'SELECT manifest FROM reconcile_run_manifests WHERE run_key = $1',
    [runKey],
  );
  return result.rows[0]!.manifest;
}

async function containment(pool: Pool) {
  const result = await pool.query(
    `SELECT incident_reference, opened_run_key, episode, state, cited_findings
     FROM reconcile_trade_containments WHERE trade_id = '7'`,
  );
  return result.rows[0];
}

test(
  'containment lineage and signed containment state (review R01/R03)',
  { timeout: 300_000, skip: !dockerAvailable },
  async (t) => {
    await withPostgresContainer(async ({ port }: { port: number }) => {
      const admin: AdminPool = await createAdminPool(port);
      try {
        await admin.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
        const scenario = scenarioRunner(t, port, admin, 'lineage');

        await scenario(
          'containment timestamps remain UTC with a non-UTC SQL session',
          async (pool) => {
            await claimOrThrow(pool, 'timezone-worker', 'timezone-run');
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await client.query("SET LOCAL TIME ZONE 'Africa/Dar_es_Salaam'");
              const { rows } = await client.query<{ at: Date }>('SELECT NOW() AS at');
              const { row } = await openContainment(
                {
                  tradeId: '7',
                  incidentReference: 'RECON-TIMEZONE',
                  runKey: 'timezone-run',
                  qualifyingCodes: ['AMOUNT_MISMATCH'],
                  evidence: {},
                },
                client,
              );
              assert.equal(row.opened_at.getTime(), rows[0]!.at.getTime());
              assert.equal(row.updated_at.getTime(), rows[0]!.at.getTime());
              assert.equal(
                (await getContainment('7', client))!.opened_at.getTime(),
                rows[0]!.at.getTime(),
              );
              await client.query('ROLLBACK');
            } finally {
              client.release();
            }
          },
        );

        await scenario(
          'a repeat divergence keeps every cited finding with its run',
          async (pool) => {
            await divergingRun(pool, 'run-a', drift('101'));
            const firstRequest = await pool.query(
              'SELECT request_id, request FROM reconcile_governance_freeze_requests',
            );
            assert.equal(firstRequest.rows.length, 1);
            assert.equal(firstRequest.rows[0].request.requiresGovernanceApproval, true);
            await divergingRun(pool, 'run-b', drift('102'));
            const repeatedRequest = await pool.query(
              'SELECT request_id FROM reconcile_governance_freeze_requests',
            );
            assert.deepEqual(repeatedRequest.rows, [
              { request_id: firstRequest.rows[0].request_id },
            ]);

            const row = await containment(pool);
            assert.equal(row.opened_run_key, 'run-a');
            assert.equal(row.incident_reference, 'RECON-20261124-RUNA');
            assert.deepEqual(
              [...row.cited_findings].sort((x: { runKey: string }, y: { runKey: string }) =>
                x.runKey.localeCompare(y.runKey),
              ),
              [
                { runKey: 'run-a', digest: findingDigest({ runKey: 'run-a', ...drift('101') }) },
                { runKey: 'run-b', digest: findingDigest({ runKey: 'run-b', ...drift('102') }) },
              ],
            );
          },
        );

        await scenario('each sealed run signs the containment state it leaves', async (pool) => {
          await divergingRun(pool, 'run-a', drift('101'));
          const opened = await manifestOf(pool, 'run-a');
          assert.deepEqual(opened.context, {
            chainId: Number(BASE_TEST_ENV.CHAIN_ID),
            escrowAddress: BASE_TEST_ENV.ESCROW_ADDRESS.toLowerCase(),
          });
          assert.deepEqual(opened.clearances, []);
          assert.equal(opened.containments?.length, 1);
          const current = await getContainment('7', pool);
          assert.equal(Date.parse(opened.containments![0].openedAt!), current!.opened_at.getTime());
          assert.deepEqual(opened.containments?.[0], {
            openedAt: opened.containments![0].openedAt,
            qualifyingCodes: ['AMOUNT_MISMATCH'],
            tradeId: '7',
            incidentReference: 'RECON-20261124-RUNA',
            episode: 1,
            state: 'CONTAINED',
            openedRunKey: 'run-a',
            clearedRunKey: null,
            citedFindings: [
              { runKey: 'run-a', digest: findingDigest({ runKey: 'run-a', ...drift('101') }) },
            ],
          });

          // A later clean run asserts the clearance explicitly, in its own manifest.
          await cleanRun(pool, 'run-c');
          const cleared = await manifestOf(pool, 'run-c');
          assert.deepEqual(cleared.clearances, [
            { tradeId: '7', incidentReference: 'RECON-20261124-RUNA', episode: 1 },
          ]);
          assert.equal(cleared.containments?.[0]?.state, 'RECONCILED_PENDING_APPROVAL');
          assert.equal(cleared.containments?.[0]?.clearedRunKey, 'run-c');

          // A divergence after clearance shows in the next sealed state, not cleared.
          await divergingRun(pool, 'run-d', drift('103'));
          const again = await manifestOf(pool, 'run-d');
          assert.equal(again.containments?.[0]?.state, 'CONTAINED');
          assert.equal(again.containments?.[0]?.clearedRunKey, null);
          assert.deepEqual(again.clearances, []);
          assert.equal(again.containments?.[0]?.citedFindings.length, 2);
        });

        await scenario(
          'a signed contradictory clearance can be replaced without rewriting history',
          async (pool) => {
            const finding = drift('101');
            await divergingRun(pool, 'run-a', finding);
            await cleanRun(pool, 'old-clearing-run', finding);
            const original = await manifestOf(pool, 'old-clearing-run');
            assert.equal(original.containments?.[0]?.clearedRunKey, 'old-clearing-run');

            const publicKeys = parsePublicKeys(
              JSON.stringify({
                [SIGNER.keyId]: localPublicKeyDerBase64(
                  BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY,
                ),
              }),
            );
            const decision = async () =>
              verifyContainmentRecovery(await loadContainmentRecoveryBundle(pool, '7'), {
                publicKeys,
                context: {
                  chainId: Number(BASE_TEST_ENV.CHAIN_ID),
                  escrowAddress: BASE_TEST_ENV.ESCROW_ADDRESS,
                },
                maxAgeSeconds: 900,
                matchesIncident: (reference) => reference === 'RECON-20261124-RUNA',
              });
            assert.deepEqual(await decision(), {
              decision: 'refused',
              reason: 'clearance_invalid',
              detail: 'clearing_run_has_qualifying_finding',
            });

            await cleanRun(pool, 'replacement');
            await cleanRun(pool, 'further-clean-run');
            const recovered = await decision();
            assert.equal(recovered.decision, 'reconciliation_recovery_verified');
            assert.equal(recovered.evidence.clearedRunKey, 'replacement');
            assert.equal(recovered.evidence.citedFindings, 1);
            assert.deepEqual(await manifestOf(pool, 'old-clearing-run'), original);
          },
        );

        await scenario('a released trade that diverges again is a new incident', async (pool) => {
          await divergingRun(pool, 'run-a', drift('101'));
          await recordPauseObservation(pausedAt('7'), pool);
          await cleanRun(pool, 'run-c');
          await releaseContainment(
            { tradeId: '7', evidence: approval(), expected: await getContainment('7', pool) },
            pool,
          );

          await divergingRun(pool, 'run-e', drift('104'));
          const row = await containment(pool);
          assert.equal(row.state, 'CONTAINED');
          assert.equal(row.episode, 2);
          assert.equal(row.incident_reference, 'RECON-20261124-RUNE');
          assert.equal(row.opened_run_key, 'run-e');
          assert.deepEqual(row.cited_findings, [
            { runKey: 'run-e', digest: findingDigest({ runKey: 'run-e', ...drift('104') }) },
          ]);
          const sealed = await manifestOf(pool, 'run-e');
          assert.equal(sealed.containments?.[0]?.incidentReference, 'RECON-20261124-RUNE');
          assert.equal(sealed.containments?.[0]?.episode, 2);
        });
      } finally {
        await admin.end();
      }
    });
  },
);
