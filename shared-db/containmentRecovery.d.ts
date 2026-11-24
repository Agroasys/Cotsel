import type { KeyObject } from 'node:crypto';
import type { QueryExecutor, RunManifest } from './reconciliationEvidence';

export const RISK_RULE_SETS: Readonly<
  Record<string, { contain: readonly string[]; record: readonly string[] }>
>;
export function ruleSetDigest(version: string): string | null;

export interface ContainmentRecoveryBundle {
  tradeId: string;
  latest: { runKey: string; seal: { manifest: RunManifest; signature: string; keyId: string } };
  runs: Record<string, unknown>;
}

export type ContainmentRecoveryDecision =
  | {
      decision: 'no_reconciliation_containment';
      evidence: { latestRunKey: string; latestCompletedAt: string | null };
    }
  | {
      decision: 'reconciliation_recovery_verified';
      evidence: {
        latestRunKey: string;
        latestCompletedAt: string | null;
        incidentReference: string;
        episode: number;
        clearedRunKey: string;
        citedFindings: number;
        manifestDigest: string;
      };
    }
  | {
      decision: 'refused';
      reason:
        | 'reconciliation_evidence_invalid'
        | 'reconciliation_evidence_stale'
        | 'reconciliation_incident_without_containment'
        | 'incident_mismatch'
        | 'containment_not_cleared'
        | 'clearance_invalid';
      detail: string | null;
    };

export function verifyContainmentRecovery(
  bundle: unknown,
  options: {
    publicKeys: ReadonlyMap<string, KeyObject>;
    context: { chainId: number | null; escrowAddress: string };
    maxAgeSeconds: number;
    expectedTradeId?: string;
    now?: number;
    matchesIncident?: (incidentReference: string) => boolean;
    incidentIsReconciliation?: boolean;
  },
): ContainmentRecoveryDecision;

export function loadContainmentRecoveryBundle(
  db: QueryExecutor,
  tradeId: string,
): Promise<ContainmentRecoveryBundle | null>;
