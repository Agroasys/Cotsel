// Must come first: the database modules below load src/config.ts on import,
// and the config needs a valid environment before that happens.
import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  findingDigest,
  parsePublicKeys,
  verifyRunEvidence,
} from '@agroasys/shared-db/reconciliationEvidence';
import { finalizeRun, upsertDrift, upsertRunTradeScope } from '../database/queries';
import {
  createLocalFindingSigner,
  FindingSigningError,
  localPublicKeyDerBase64,
} from '../core/findingSigner';
import { RISK_RULES_V1_DIGEST, RISK_RULES_VERSION } from '../core/riskRules';
import { reportEvidence } from '../core/reportEvidence';
import type { DriftFinding } from '../types';
import { BASE_TEST_ENV } from './helpers/reconciliationEnv';
import {
  createAdminPool,
  dockerAvailable,
  RUNTIME_ROLE,
  scenarioRunner,
  stats,
  claimOrThrow,
  withPostgresContainer,
  type AdminPool,
} from './helpers/reconciliationPostgres';

const SIGNER = createLocalFindingSigner(
  'reconciliation-test-key',
  BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY,
);
const KEYS = parsePublicKeys(
  JSON.stringify({
    [SIGNER.keyId]: localPublicKeyDerBase64(BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY),
  }),
);

// Unsorted keys and mixed scalars: JSONB reorders keys, so the digest must be
// canonical rather than whatever order the row comes back in.
const FINDINGS: DriftFinding[] = [
  {
    tradeId: '7',
    severity: 'CRITICAL',
    mismatchCode: 'AMOUNT_MISMATCH',
    comparedField: 'totalAmountLocked',
    onchainValue: '100',
    indexedValue: '101',
    details: { zeta: 1, alpha: 'x', note: null, flagged: true, ratio: 0.5 },
  },
  {
    tradeId: '8',
    severity: 'HIGH',
    mismatchCode: 'STATUS_MISMATCH',
    comparedField: 'status',
    onchainValue: null,
    indexedValue: 'LOCKED',
    details: {},
  },
];

/** Completes run daemon-1 with FINDINGS and a three-trade scope, sealed by `signer`. */
async function completeSignedRun(pool: Pool, signer = SIGNER): Promise<void> {
  const run = await claimOrThrow(pool, 'worker-a');
  await finalizeRun(
    {
      stats: { ...stats('daemon-1'), driftCount: FINDINGS.length },
      lease: run.lease,
      publish: async (client) => {
        for (const tradeId of ['7', '8', '9']) {
          await upsertRunTradeScope(run.row.id, 'daemon-1', tradeId, client);
        }
        for (const finding of FINDINGS) await upsertDrift(run.row.id, 'daemon-1', finding, client);
      },
      cursor: { advance: false, tailFirstSeenAt: null },
    },
    pool,
    signer,
  );
}

/** Tamper the way a database owner could: with the published-evidence triggers bypassed. */
async function tamper(pool: Pool, sql: string, values: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(sql, values);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

test(
  'signed reconciliation findings (Cotsel#951)',
  { timeout: 300_000, skip: !dockerAvailable },
  async (t) => {
    await withPostgresContainer(async ({ port }: { port: number }) => {
      const admin: AdminPool = await createAdminPool(port);
      try {
        await admin.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
        const scenario = scenarioRunner(t, port, admin, 'signed');

        await scenario('a completed run is sealed and verifies', async (pool) => {
          await completeSignedRun(pool);
          const result = await verifyRunEvidence(pool, 'daemon-1', KEYS);
          assert.equal(result.ok, true);
          if (!result.ok) return;
          assert.equal(result.manifest.findings.count, 2);
          assert.equal(result.manifest.scope.count, 3);
          assert.deepEqual(result.manifest.rules, {
            version: RISK_RULES_VERSION,
            digest: RISK_RULES_V1_DIGEST,
          });
          // A finding is verifiable on its own: its in-memory digest is listed.
          for (const finding of FINDINGS) {
            assert.ok(
              result.manifest.findings.digests.includes(
                findingDigest({ runKey: 'daemon-1', ...finding }),
              ),
            );
          }
        });

        const tampering: Array<[string, string, string]> = [
          [
            'an altered finding value',
            `UPDATE reconcile_drifts SET indexed_value = '100' WHERE trade_id = '7'`,
            'findings_mismatch',
          ],
          [
            'a deleted finding, which would otherwise clear the trade',
            `DELETE FROM reconcile_drifts WHERE trade_id = '7'`,
            'findings_mismatch',
          ],
          [
            'an injected finding',
            `INSERT INTO reconcile_drifts (run_id, run_key, trade_id, severity, mismatch_code, compared_field, details)
             SELECT id, run_key, '9', 'LOW', 'STATUS_MISMATCH', 'status', '{}' FROM reconcile_runs WHERE run_key = 'daemon-1'`,
            'findings_mismatch',
          ],
          [
            'an injected scope row for a trade never compared',
            `INSERT INTO reconcile_run_trades (run_id, run_key, trade_id)
             SELECT id, run_key, '10' FROM reconcile_runs WHERE run_key = 'daemon-1'`,
            'scope_mismatch',
          ],
          [
            'a flipped coverage flag',
            `UPDATE reconcile_runs SET coverage_complete = NOT COALESCE(coverage_complete, false) WHERE run_key = 'daemon-1'`,
            'run_mismatch',
          ],
          [
            'a moved completion time, which would make a stale run look fresh',
            `UPDATE reconcile_runs SET completed_at = completed_at + INTERVAL '1 hour' WHERE run_key = 'daemon-1'`,
            'run_mismatch',
          ],
          [
            'a rewritten manifest',
            `UPDATE reconcile_run_manifests SET manifest = jsonb_set(manifest, '{findings,count}', '1') WHERE run_key = 'daemon-1'`,
            'bad_signature',
          ],
          [
            'a deleted manifest',
            `DELETE FROM reconcile_run_manifests WHERE run_key = 'daemon-1'`,
            'unsigned',
          ],
        ];
        for (const [label, sql, reason] of tampering) {
          await scenario(`${label} fails verification`, async (pool) => {
            await completeSignedRun(pool);
            await tamper(pool, sql);
            assert.deepEqual(await verifyRunEvidence(pool, 'daemon-1', KEYS), {
              ok: false,
              reason,
            });
          });
        }

        await scenario('the report CLI says whether the run verifies', async (pool) => {
          const keys = JSON.stringify({
            [SIGNER.keyId]: localPublicKeyDerBase64(
              BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY,
            ),
          });
          const previous = process.env.RECONCILIATION_FINDING_PUBLIC_KEYS;
          try {
            delete process.env.RECONCILIATION_FINDING_PUBLIC_KEYS;
            await completeSignedRun(pool);
            assert.equal((await reportEvidence(pool, 'daemon-1')).status, 'unverifiable');
            process.env.RECONCILIATION_FINDING_PUBLIC_KEYS = keys;
            assert.deepEqual(await reportEvidence(pool, 'daemon-1'), {
              status: 'verified',
              keyId: SIGNER.keyId,
              findingCount: 2,
            });
            await tamper(pool, `DELETE FROM reconcile_drifts WHERE trade_id = '7'`);
            assert.deepEqual(await reportEvidence(pool, 'daemon-1'), {
              status: 'failed',
              reason: 'findings_mismatch',
            });
            await tamper(pool, `DELETE FROM reconcile_run_manifests`);
            assert.deepEqual(await reportEvidence(pool, 'daemon-1'), { status: 'unsigned' });
          } finally {
            if (previous === undefined) delete process.env.RECONCILIATION_FINDING_PUBLIC_KEYS;
            else process.env.RECONCILIATION_FINDING_PUBLIC_KEYS = previous;
          }
        });

        await scenario('a key the verifier does not hold is refused', async (pool) => {
          await completeSignedRun(pool);
          const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
          const otherKeys = parsePublicKeys(
            JSON.stringify({
              'another-key': publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
            }),
          );
          assert.deepEqual(await verifyRunEvidence(pool, 'daemon-1', otherKeys), {
            ok: false,
            reason: 'unknown_key',
          });
        });

        await scenario('a signature from a different key under the same id fails', async (pool) => {
          const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
          const impostor = createLocalFindingSigner(
            SIGNER.keyId,
            privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
          );
          await completeSignedRun(pool, impostor);
          assert.deepEqual(await verifyRunEvidence(pool, 'daemon-1', KEYS), {
            ok: false,
            reason: 'bad_signature',
          });
        });

        await scenario('a signing failure holds the run: nothing is published', async (pool) => {
          const failing = {
            keyId: SIGNER.keyId,
            sign: async () => {
              throw new Error('KMS unavailable');
            },
          };
          await assert.rejects(completeSignedRun(pool, failing), FindingSigningError);
          const run = await pool.query(
            `SELECT status, export_evidence_version FROM reconcile_runs WHERE run_key = 'daemon-1'`,
          );
          assert.equal(run.rows[0].status, 'RUNNING');
          assert.equal(run.rows[0].export_evidence_version, null);
          for (const table of [
            'reconcile_drifts',
            'reconcile_run_trades',
            'reconcile_run_manifests',
          ]) {
            const rows = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
            assert.equal(rows.rows[0].n, 0, `${table} rolled back`);
          }
        });

        await scenario(
          'a manifest is written only while its run completes, and never changes',
          async (pool) => {
            await completeSignedRun(pool);
            await assert.rejects(
              pool.query(`UPDATE reconcile_run_manifests SET key_id = key_id`),
              /reconcile_run_manifest_is_immutable/,
            );
            await assert.rejects(
              pool.query(`DELETE FROM reconcile_run_manifests`),
              /reconcile_run_manifest_is_immutable/,
            );
            const second = await claimOrThrow(pool, 'worker-b', 'daemon-2');
            await assert.rejects(
              pool.query(
                `INSERT INTO reconcile_run_manifests (run_key, schema_version, manifest, signature, key_id)
               VALUES ($1::text, 'cotsel.reconciliation-run-manifest.v1',
                 jsonb_build_object('runKey', $1::text, 'schemaVersion', 'cotsel.reconciliation-run-manifest.v1', 'keyId', 'k'),
                 'AAAA', 'k')`,
                [second.lease.runKey],
              ),
              /reconcile_run_manifest_requires_completed_run/,
            );
          },
        );
      } finally {
        await admin.end();
      }
    });
  },
);
