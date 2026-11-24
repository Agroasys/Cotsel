/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * How the gateway checks signed reconciliation evidence (Cotsel#951): it asks
 * reconciliation's internal service (GATEWAY_RECONCILIATION_BASE_URL) for the
 * raw rows and seals, and verifies them itself with this key ring, against its
 * own chain and escrow, requiring the newest sealed run to be at most
 * GATEWAY_RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS old. The gateway never
 * connects to the reconciliation database (failure-domain isolation).
 * Unset keys or base URL mean every action that depends on the evidence is
 * refused.
 */
import type { KeyObject } from 'node:crypto';
import { parsePublicKeys } from '@agroasys/shared-db/reconciliationEvidence';

/** Default freshness: fifteen 60-second daemon intervals. */
export const DEFAULT_RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS = 900;

export interface ReconciliationEvidenceConfig {
  baseUrl: string;
  publicKeys: ReadonlyMap<string, KeyObject>;
  timeoutMs: number;
  /** The chain and escrow this gateway governs; evidence for others is refused. */
  context: { chainId: number | null; escrowAddress: string };
  maxAgeSeconds: number;
}

export function loadReconciliationEvidenceConfig(
  baseUrl: string | undefined,
  context: { chainId: number | null; escrowAddress: string | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): ReconciliationEvidenceConfig | null {
  const keys = env.RECONCILIATION_FINDING_PUBLIC_KEYS?.trim();
  if (!keys || !baseUrl || !context.escrowAddress) return null;
  const rawMaxAge = env.GATEWAY_RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS?.trim();
  const maxAgeSeconds = rawMaxAge
    ? Number(rawMaxAge)
    : DEFAULT_RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 86_400) {
    throw new Error('GATEWAY_RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS must be an integer 60..86400');
  }
  return {
    baseUrl: baseUrl.replace(/\/$/u, ''),
    publicKeys: parsePublicKeys(keys),
    timeoutMs: 10_000,
    context: { chainId: context.chainId, escrowAddress: context.escrowAddress.toLowerCase() },
    maxAgeSeconds,
  };
}
