/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Completes and seals a reconciliation run the way reconciliation's finalizeRun
 * does (Cotsel#951), so treasury tests read evidence that verifies. The key is
 * generated per process and used for nothing else.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import type { Pool } from 'pg';
import {
  buildRunManifest,
  manifestBytes,
  parsePublicKeys,
  readRunEvidence,
  verifyRunEvidence,
} from '@agroasys/shared-db/reconciliationEvidence';
import type { RunEvidenceVerifier } from '../../src/core/reconciliationEvidenceGate';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

export const TEST_FINDING_KEY_ID = 'treasury-test-finding-key';
export const TEST_FINDING_PUBLIC_KEYS_JSON = JSON.stringify({
  [TEST_FINDING_KEY_ID]: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
});
const TEST_KEYS = parsePublicKeys(TEST_FINDING_PUBLIC_KEYS_JSON);

export const testRunVerifier: RunEvidenceVerifier = (reader, runKey) =>
  verifyRunEvidence(reader, runKey, TEST_KEYS);

/** Runs `completeSql` (which completes `runKey`) and seals the run in the same transaction. */
export async function completeAndSealRun(
  pool: Pool,
  runKey: string,
  completeSql: string,
  values: unknown[] = [],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(completeSql, values);
    const evidence = await readRunEvidence(client, runKey);
    if (!evidence) throw new Error(`run ${runKey} does not exist`);
    const manifest = buildRunManifest(evidence, {
      keyId: TEST_FINDING_KEY_ID,
      rulesVersion: 'cotsel.reconciliation-risk-rules.v1',
      rulesDigest: 'treasury-test',
    });
    await client.query(
      `INSERT INTO reconcile_run_manifests (run_key, schema_version, manifest, signature, key_id)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        runKey,
        manifest.schemaVersion,
        JSON.stringify(manifest),
        sign('sha256', manifestBytes(manifest), privateKey).toString('base64'),
        TEST_FINDING_KEY_ID,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
