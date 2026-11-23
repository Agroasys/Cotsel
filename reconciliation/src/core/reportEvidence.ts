import type { Pool } from 'pg';
import {
  classifyRunFindings,
  findingDigest,
  parsePublicKeys,
  readRunEvidence,
  type ClassifiedFinding,
} from '@agroasys/shared-db/reconciliationEvidence';

/** A finding as the report shows it; `unverifiable` when no keys are configured. */
export type ReportFinding =
  ClassifiedFinding | (Omit<ClassifiedFinding, 'status'> & { status: 'unverifiable' });

/** How the report CLI describes a run's signed evidence (Cotsel#951). */
export type ReportEvidence = (
  | { status: 'verified'; keyId: string; findingCount: number }
  | { status: 'failed'; reason: string }
  | { status: 'unsigned' }
  | { status: 'unverifiable'; reason: 'RECONCILIATION_FINDING_PUBLIC_KEYS is not set' }
) & { findings: ReportFinding[] };

/**
 * Verifies the reported run against its signed manifest with the keys in
 * RECONCILIATION_FINDING_PUBLIC_KEYS, and marks each finding verified, failed,
 * missing (listed but deleted) or unsigned. A report never presents findings
 * as trustworthy on its own say-so: without keys it says it could not check.
 */
export async function reportEvidence(
  pool: Pick<Pool, 'query'>,
  runKey: string,
): Promise<ReportEvidence> {
  const keys = process.env.RECONCILIATION_FINDING_PUBLIC_KEYS?.trim();
  if (!keys) {
    const evidence = await readRunEvidence(pool, runKey);
    return {
      status: 'unverifiable',
      reason: 'RECONCILIATION_FINDING_PUBLIC_KEYS is not set',
      findings: (evidence?.findings ?? []).map((finding) => ({
        tradeId: finding.tradeId,
        mismatchCode: finding.mismatchCode,
        comparedField: finding.comparedField,
        digest: findingDigest(finding),
        status: 'unverifiable' as const,
      })),
    };
  }
  const { run, findings } = await classifyRunFindings(pool, runKey, parsePublicKeys(keys));
  if (run.ok) {
    return {
      status: 'verified',
      keyId: run.manifest.keyId,
      findingCount: run.manifest.findings.count,
      findings,
    };
  }
  return run.reason === 'unsigned'
    ? { status: 'unsigned', findings }
    : { status: 'failed', reason: run.reason, findings };
}
