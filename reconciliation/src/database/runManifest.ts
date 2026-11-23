import type { PoolClient } from 'pg';
import {
  buildRunManifest,
  manifestBytes,
  readRunEvidence,
  type RunManifest,
} from '@agroasys/shared-db/reconciliationEvidence';
import { config } from '../config';
import {
  createFindingSigner,
  FindingSigningError,
  type FindingSigner,
} from '../core/findingSigner';
import { RISK_RULES_V1_DIGEST, RISK_RULES_VERSION } from '../core/riskRules';
import { Logger } from '../utils/logger';

let configuredSigner: FindingSigner | undefined;

/** The signer from configuration; throws when none is configured. */
export function configuredFindingSigner(): FindingSigner {
  configuredSigner ??= createFindingSigner(config.findingSigner, config.findingSignTimeoutMs);
  return configuredSigner;
}

/**
 * Seal a completed run (Cotsel#951): read back its committed-to-be evidence
 * through the same reader verifiers use, sign the manifest, and store it.
 *
 * Runs inside finalizeRun's fenced transaction, after the run row is completed
 * and before COMMIT. Reading the evidence back, rather than signing what the
 * run holds in memory, covers the rows a finishing enumeration cycle copies in
 * from earlier runs. If signing fails, the transaction rolls back: the run is
 * not completed, the cursor holds, and nothing is published unsigned.
 */
export async function sealRunManifest(
  client: PoolClient,
  runKey: string,
  signer: FindingSigner,
): Promise<RunManifest> {
  const evidence = await readRunEvidence(client, runKey);
  if (!evidence || evidence.status !== 'COMPLETED') {
    throw new FindingSigningError(`Run ${runKey} is not completed; refusing to seal it`);
  }
  const manifest = buildRunManifest(evidence, {
    keyId: signer.keyId,
    rulesVersion: RISK_RULES_VERSION,
    rulesDigest: RISK_RULES_V1_DIGEST,
  });
  let signature: Buffer;
  try {
    signature = await signer.sign(manifestBytes(manifest));
  } catch (error) {
    Logger.error('Reconciliation findings could not be signed; the run is held unpublished', {
      runKey,
      errorCode: 'RECONCILIATION_FINDINGS_SIGNING_FAILED',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error instanceof FindingSigningError
      ? error
      : new FindingSigningError('The run manifest could not be signed', { cause: error });
  }
  await client.query(
    `INSERT INTO reconcile_run_manifests (run_key, schema_version, manifest, signature, key_id)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [
      runKey,
      manifest.schemaVersion,
      JSON.stringify(manifest),
      signature.toString('base64'),
      signer.keyId,
    ],
  );
  return manifest;
}
