import type { Pool } from 'pg';
import {
  loadContainmentEvidenceBundle,
  loadOpenContainmentEvidenceBundles,
} from '@agroasys/shared-db/reconciliationEvidence';

/**
 * Raw signed containment evidence for the gateway (Cotsel#951), served on the
 * internal service port. The gateway verifies signatures and digests itself,
 * so this endpoint is a transport, not an authority: it returns the rows and
 * the seal, never a verdict. Each response is one consistent snapshot.
 */
export async function serveContainmentEvidence(
  pool: Pool,
  pathname: string,
): Promise<{ status: number; body: unknown } | null> {
  const match = /^\/containments(?:\/([0-9]{1,78}))?$/u.exec(pathname);
  if (!match) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tradeId = match[1];
    const body = tradeId
      ? await loadContainmentEvidenceBundle(client, tradeId)
      : { items: await loadOpenContainmentEvidenceBundles(client) };
    await client.query('COMMIT');
    return body ? { status: 200, body } : { status: 404, body: { error: 'containment_not_found' } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
