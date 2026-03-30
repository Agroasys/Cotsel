/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { buildExplorerTxUrl } from '@agroasys/sdk';

export interface SettlementTransactionReference {
  txHash: string | null;
  extrinsicHash: string | null;
  explorerUrl: string | null;
}

function normalizeHash(value?: string | null): string | null {
  const normalized = value?.trim() || null;
  return normalized && normalized.length > 0 ? normalized : null;
}

export function buildSettlementTransactionReference(
  txHash?: string | null,
  extrinsicHash?: string | null,
  explorerBaseUrl?: string | null,
): SettlementTransactionReference {
  const canonicalTxHash = normalizeHash(txHash);
  const legacyExtrinsicHash = normalizeHash(extrinsicHash);

  return {
    txHash: canonicalTxHash,
    extrinsicHash: legacyExtrinsicHash,
    explorerUrl: buildExplorerTxUrl(explorerBaseUrl, canonicalTxHash),
  };
}

export function requiresCanonicalTxHash(executionStatus: string): boolean {
  return executionStatus === 'submitted' || executionStatus === 'confirmed';
}
