/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * How the gateway checks signed reconciliation evidence (Cotsel#951): it asks
 * reconciliation's internal service (GATEWAY_RECONCILIATION_BASE_URL) for the
 * raw rows and seal, and verifies them with this key ring itself. The gateway
 * never connects to the reconciliation database (failure-domain isolation).
 * Unset means every action that depends on that evidence is refused.
 */
import type { KeyObject } from 'node:crypto';
import { parsePublicKeys } from '@agroasys/shared-db/reconciliationEvidence';

export interface ReconciliationEvidenceConfig {
  baseUrl: string;
  publicKeys: ReadonlyMap<string, KeyObject>;
  timeoutMs: number;
}

export function loadReconciliationEvidenceConfig(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ReconciliationEvidenceConfig | null {
  const keys = env.RECONCILIATION_FINDING_PUBLIC_KEYS?.trim();
  if (!keys || !baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/u, ''),
    publicKeys: parsePublicKeys(keys),
    timeoutMs: 10_000,
  };
}
