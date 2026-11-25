import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  loadContainmentRecoveryBundle,
  verifyContainmentRecovery,
} from '@agroasys/shared-db/containmentRecovery';
import { parsePublicKeys } from '@agroasys/shared-db/reconciliationEvidence';
import { localPublicKeyDerBase64 } from '../../core/findingSigner';
import type { RunStats } from '../../types';
import { BASE_TEST_ENV } from './reconciliationEnv';

export async function assertContainmentRecoversAfterCycleRetry(
  db: Pool,
  once: () => Promise<RunStats>,
  setTradeMissing: (missing: boolean) => void,
): Promise<void> {
  const publicKeys = parsePublicKeys(
    JSON.stringify({
      'reconciliation-test-key': localPublicKeyDerBase64(
        BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY,
      ),
    }),
  );
  const decision = async (incidentReference: string) =>
    verifyContainmentRecovery(await loadContainmentRecoveryBundle(db, '0'), {
      publicKeys,
      context: {
        chainId: Number(BASE_TEST_ENV.CHAIN_ID),
        escrowAddress: BASE_TEST_ENV.ESCROW_ADDRESS,
      },
      maxAgeSeconds: 900,
      expectedTradeId: '0',
      matchesIncident: (reference) => reference === incidentReference,
      incidentIsReconciliation: true,
    });

  setTradeMissing(true);
  const divergence = await once();
  const opened = (await loadContainmentRecoveryBundle(
    db,
    '0',
  ))!.latest.seal.manifest.containments!.find((entry) => entry.tradeId === '0')!;
  assert.equal(opened.openedRunKey, divergence.runKey);
  assert.deepEqual(opened.qualifyingCodes, ['INDEXER_TRADE_MISSING']);
  assert.equal(divergence.coverage?.cursorAdvanced, false);

  setTradeMissing(false);
  const retry = await once();
  assert.equal(retry.coverage?.enumerationCycleId, divergence.coverage?.enumerationCycleId);
  assert.equal(retry.driftCount, 1, 'terminal evidence retains the earlier finding');
  assert.deepEqual(await decision(opened.incidentReference), {
    decision: 'refused',
    reason: 'containment_not_cleared',
    detail: 'CONTAINED',
  });
  const retryManifest = (await loadContainmentRecoveryBundle(db, '0'))!.latest.seal.manifest;
  assert.ok(!retryManifest.clearances!.some((entry) => entry.tradeId === '0'));

  const fresh = await once();
  assert.notEqual(fresh.coverage?.enumerationCycleId, retry.coverage?.enumerationCycleId);
  assert.equal(fresh.coverage?.complete, true);
  const recovered = await decision(opened.incidentReference);
  assert.equal(recovered.decision, 'reconciliation_recovery_verified', JSON.stringify(recovered));
  assert.equal(recovered.evidence.clearedRunKey, fresh.runKey);
  assert.equal(recovered.evidence.episode, opened.episode);
  assert.equal(recovered.evidence.citedFindings, 1);

  setTradeMissing(true);
  const repeated = await once();
  const reopened = (await loadContainmentRecoveryBundle(
    db,
    '0',
  ))!.latest.seal.manifest.containments!.find((entry) => entry.tradeId === '0')!;
  assert.deepEqual(await decision(opened.incidentReference), {
    decision: 'refused',
    reason: 'containment_not_cleared',
    detail: 'CONTAINED',
  });
  assert.equal(reopened.incidentReference, opened.incidentReference);
  assert.equal(reopened.episode, opened.episode);
  assert.equal(reopened.clearedRunKey, null);
  assert.deepEqual(
    reopened.citedFindings.map((finding) => finding.runKey).sort(),
    [divergence.runKey, repeated.runKey].sort(),
  );
}
