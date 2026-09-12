import { randomBytes } from 'node:crypto';
import type { DriftCode, DriftFinding } from '../types';

/**
 * The discrepancy codes that qualify a trade for scoped containment.
 *
 * Qualification is about the *kind* of divergence, not the alert severity: a
 * qualifying code means the chain and the projection disagree about who was
 * paid, how much, or which agreement a trade settles — a difference that cannot
 * be resolved by waiting, and that must not progress to payout while it stands.
 *
 * Deliberately excluded, and why:
 * - `ONCHAIN_READ_ERROR` is inconclusive. A transient RPC failure proves
 *   nothing about the trade, and the coverage control already holds the cursor
 *   on it. Pausing a trade on a read blip would contain healthy settlement.
 * - `INDEXER_SURPLUS_RECORDS` is a whole-projection count, not attributable to
 *   one trade, so it cannot scope a pause to the affected trade.
 * - `STATUS_MISMATCH` and `ARRIVAL_TIMESTAMP_MISMATCH` are lifecycle-lag
 *   shapes that resolve as the projection catches up.
 * - `INDEXED_INVALID_ADDRESS` and `ONCHAIN_INVALID_ADDRESS` report an
 *   unusable value rather than a proven disagreement; a real divergence in the
 *   parties surfaces as `PARTICIPANT_MISMATCH`.
 */
export const QUALIFYING_DISCREPANCY_CODES: ReadonlySet<DriftCode> = new Set<DriftCode>([
  'AMOUNT_MISMATCH',
  'FEE_COMPONENT_MISMATCH',
  'PARTICIPANT_MISMATCH',
  'HASH_MISMATCH',
  'ONCHAIN_TRADE_MISSING',
  'INDEXER_TRADE_MISSING',
]);

export function isQualifyingDiscrepancy(finding: DriftFinding): boolean {
  return QUALIFYING_DISCREPANCY_CODES.has(finding.mismatchCode);
}

export interface QualifiedDiscrepancy {
  tradeId: string;
  codes: DriftCode[];
  findings: DriftFinding[];
}

/**
 * Group a run's qualifying findings by trade.
 *
 * Containment is per trade, so several qualifying findings on one trade open a
 * single incident rather than competing ones.
 */
export function qualifyDiscrepancies(findings: DriftFinding[]): QualifiedDiscrepancy[] {
  const byTrade = new Map<string, QualifiedDiscrepancy>();

  for (const finding of findings) {
    if (!isQualifyingDiscrepancy(finding)) {
      continue;
    }

    const existing = byTrade.get(finding.tradeId);
    if (existing) {
      if (!existing.codes.includes(finding.mismatchCode)) {
        existing.codes.push(finding.mismatchCode);
      }
      existing.findings.push(finding);
      continue;
    }

    byTrade.set(finding.tradeId, {
      tradeId: finding.tradeId,
      codes: [finding.mismatchCode],
      findings: [finding],
    });
  }

  return [...byTrade.values()];
}

/**
 * A short, quotable incident reference an operator can carry into the pause
 * request, the runbook, and the governed approval that eventually clears it.
 *
 * The trade id is not encoded: a uint256 id does not fit alongside a prefix in
 * the reference column, and the containment row already carries it.
 */
export function generateIncidentReference(now: Date = new Date()): string {
  const day =
    `${now.getUTCFullYear()}` +
    `${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(now.getUTCDate()).padStart(2, '0')}`;

  return `RECON-${day}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * The evidence snapshot preserved with an incident.
 *
 * Kept alongside the containment rather than only in `reconcile_drifts`,
 * because the incident must stay readable after later runs have moved the
 * drift rows on.
 */
export function buildContainmentEvidence(input: {
  runKey: string;
  boundaryBlock: number;
  boundaryBlockHash: string;
  discrepancy: QualifiedDiscrepancy;
}): Record<string, unknown> {
  return {
    runKey: input.runKey,
    boundaryBlock: input.boundaryBlock,
    boundaryBlockHash: input.boundaryBlockHash,
    findings: input.discrepancy.findings.map((finding) => ({
      mismatchCode: finding.mismatchCode,
      comparedField: finding.comparedField,
      severity: finding.severity,
      onchainValue: finding.onchainValue,
      indexedValue: finding.indexedValue,
      details: finding.details,
    })),
  };
}
