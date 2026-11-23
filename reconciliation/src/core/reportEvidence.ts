import type { Pool } from 'pg';
import { parsePublicKeys, verifyRunEvidence } from '@agroasys/shared-db/reconciliationEvidence';

/** How the report CLI describes a run's signed evidence (Cotsel#951). */
export type ReportEvidence =
  | { status: 'verified'; keyId: string; findingCount: number }
  | { status: 'failed'; reason: string }
  | { status: 'unsigned' }
  | { status: 'unverifiable'; reason: 'RECONCILIATION_FINDING_PUBLIC_KEYS is not set' };

/**
 * Verifies the reported run against its signed manifest with the keys in
 * RECONCILIATION_FINDING_PUBLIC_KEYS. A report never presents findings as
 * trustworthy on its own say-so: without keys it says it could not check.
 */
export async function reportEvidence(
  pool: Pick<Pool, 'query'>,
  runKey: string,
): Promise<ReportEvidence> {
  const keys = process.env.RECONCILIATION_FINDING_PUBLIC_KEYS?.trim();
  if (!keys)
    return { status: 'unverifiable', reason: 'RECONCILIATION_FINDING_PUBLIC_KEYS is not set' };
  const result = await verifyRunEvidence(pool, runKey, parsePublicKeys(keys));
  if (result.ok) {
    return {
      status: 'verified',
      keyId: result.manifest.keyId,
      findingCount: result.manifest.findings.count,
    };
  }
  return result.reason === 'unsigned'
    ? { status: 'unsigned' }
    : { status: 'failed', reason: result.reason };
}
