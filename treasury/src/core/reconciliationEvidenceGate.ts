/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Signed reconciliation evidence at the treasury gate (Cotsel#951). Exports and
 * ledger snapshots trust a reconciliation run only after its signed manifest
 * verifies against the rows the decision is read from.
 */
import type { Pool } from 'pg';
import {
  verifyRunEvidence,
  type RunVerification,
} from '@agroasys/shared-db/reconciliationEvidence';
import { config } from '../config';
import { Logger } from '../utils/logger';

/** Verifies a run against its signed manifest (Cotsel#951). */
export type RunEvidenceVerifier = (
  reader: Pick<Pool, 'query'>,
  runKey: string,
) => Promise<RunVerification>;

/** The production verifier: the keys in RECONCILIATION_FINDING_PUBLIC_KEYS. */
export function configuredRunVerifier(): RunEvidenceVerifier {
  return (reader, runKey) =>
    verifyRunEvidence(reader, runKey, config.reconciliationFindingPublicKeys);
}

export const RECONCILIATION_EVIDENCE_UNSIGNED = 'reconciliation_evidence_unsigned';
export const RECONCILIATION_EVIDENCE_INVALID = 'reconciliation_evidence_invalid';

/**
 * Null when the run's evidence verifies. Otherwise the reason it cannot be
 * trusted. A run is refused, never partly trusted: an injected scope row or a
 * deleted finding would otherwise clear a trade.
 */
export function evidenceFailure(runKey: string, verification: RunVerification): string | null {
  if (verification.ok) return null;
  const code =
    verification.reason === 'unsigned'
      ? RECONCILIATION_EVIDENCE_UNSIGNED
      : RECONCILIATION_EVIDENCE_INVALID;
  Logger.error('Reconciliation evidence did not verify; exports are blocked', {
    runKey,
    errorCode:
      verification.reason === 'unsigned'
        ? 'RECONCILIATION_EVIDENCE_UNSIGNED'
        : 'RECONCILIATION_EVIDENCE_INVALID',
    reason: verification.reason,
  });
  return verification.reason === 'unsigned'
    ? `Latest completed reconciliation run is not signed (${code})`
    : `Latest completed reconciliation run failed evidence verification: ${verification.reason} (${code})`;
}
