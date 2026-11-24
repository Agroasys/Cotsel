import { attestActionEvidence } from '@agroasys/shared-db/actionEvidence';
import { configuredFindingSigner } from './database/runManifest';
import type { FindingSigner } from './core/findingSigner';
import type { Pool } from 'pg';
import {
  loadContainmentEvidenceBundle,
  loadContainmentEvidencePage,
} from '@agroasys/shared-db/reconciliationEvidence';
import { loadContainmentRecoveryBundle } from '@agroasys/shared-db/containmentRecovery';
import type { FreezeRequest } from '@agroasys/shared-db/freezeRequests';

/**
 * Raw signed containment evidence for the gateway (Cotsel#951), served on the
 * internal service port. The gateway verifies signatures and digests itself,
 * so this endpoint is a transport, not an authority: it returns the rows and
 * the seal, never a verdict. Each response is one consistent snapshot.
 *
 * - /containments and /containments/{tradeId}: display bundles.
 * - /containments/{tradeId}/recovery: what a trade-scoped unpause is decided
 *   on (review R02): the newest sealed run and every run its incident names.
 *   404 `no_sealed_run` only when no run has ever been sealed.
 */
export async function serveContainmentEvidence(
  pool: Pool,
  pathname: string,
  search: URLSearchParams = new URLSearchParams(),
  options: { signer?: () => FindingSigner; now?: () => number } = {},
): Promise<{ status: number; body: unknown } | null> {
  const match = /^\/containments(?:\/([0-9]{1,78})(\/recovery)?)?$/u.exec(pathname);
  const freeze = /^\/freeze-requests\/([a-f0-9]{64})$/u.exec(pathname);
  if (!match && !freeze) return null;
  const challenge = search.get('challenge');
  if (challenge !== null && !/^[a-f0-9]{64}$/.test(challenge))
    return { status: 400, body: { error: 'invalid_evidence_challenge' } };
  const attest = async (body: object) =>
    challenge === null
      ? body
      : attestActionEvidence(body, {
          challenge,
          resource: pathname,
          signer: (options.signer ?? configuredFindingSigner)(),
          now: options.now?.(),
        });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (freeze) {
      const result = await client.query<{ request: FreezeRequest }>(
        'SELECT request FROM reconcile_governance_freeze_requests WHERE request_id = $1',
        [freeze[1]],
      );
      const request = result.rows[0]?.request;
      const body = request
        ? { request, proof: await loadContainmentEvidenceBundle(client, request.tradeId) }
        : null;
      await client.query('COMMIT');
      return body
        ? { status: 200, body: await attest(body) }
        : { status: 404, body: { error: 'freeze_request_not_found' } };
    }
    const tradeId = match![1];
    if (tradeId && match![2]) {
      const bundle = await loadContainmentRecoveryBundle(client, tradeId);
      await client.query('COMMIT');
      return bundle
        ? { status: 200, body: await attest(bundle) }
        : { status: 404, body: { error: 'no_sealed_run' } };
    }
    const body = tradeId
      ? await loadContainmentEvidenceBundle(client, tradeId)
      : await loadContainmentEvidencePage(client, {
          limit: search.has('limit') ? Number(search.get('limit')) : undefined,
          cursor: search.get('cursor') ?? undefined,
        });
    await client.query('COMMIT');
    return body
      ? { status: 200, body: await attest(body) }
      : { status: 404, body: { error: 'containment_not_found' } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
