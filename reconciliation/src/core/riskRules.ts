import { createHash } from 'node:crypto';
import type { DriftCode } from '../types';

/**
 * Versioned risk rules (Cotsel#951): what a reconciliation finding of each
 * discrepancy code leads to.
 *
 * - `contain`: the chain and the projection disagree about who was paid, how
 *   much, or which agreement a trade settles. The difference cannot be resolved
 *   by waiting, and the trade must not progress to payout while it stands, so
 *   reconciliation opens a scoped containment. That requests a governance freeze
 *   (the escrow's per-trade pause); reconciliation never pauses on its own.
 * - `record`: the finding is kept and alerted on its severity, without
 *   containment.
 *
 * The rule set is a typed record over every `DriftCode`, so a new code cannot
 * compile without a decided outcome. A published version never changes; its
 * digest is pinned by a test. Different outcomes need a new version.
 */
export const RISK_RULES_VERSION = 'cotsel.reconciliation-risk-rules.v1';

export type RiskOutcome = 'contain' | 'record';

export interface RiskRule {
  outcome: RiskOutcome;
  /** Why the code leads to this outcome; part of the reviewed rule set. */
  reason: string;
}

export const RISK_RULES_V1: Readonly<Record<DriftCode, RiskRule>> = Object.freeze({
  AMOUNT_MISMATCH: {
    outcome: 'contain',
    reason: 'The chain and the projection disagree about how much the trade locks.',
  },
  FEE_COMPONENT_MISMATCH: {
    outcome: 'contain',
    reason: 'The chain and the projection disagree about a fee component.',
  },
  PARTICIPANT_MISMATCH: {
    outcome: 'contain',
    reason: 'The chain and the projection disagree about who the parties are.',
  },
  HASH_MISMATCH: {
    outcome: 'contain',
    reason: 'The chain and the projection disagree about which agreement the trade settles.',
  },
  ONCHAIN_TRADE_MISSING: {
    outcome: 'contain',
    reason: 'The projection holds a trade the chain does not.',
  },
  INDEXER_TRADE_MISSING: {
    outcome: 'contain',
    reason: 'The chain holds a trade the projection does not.',
  },
  ONCHAIN_READ_ERROR: {
    outcome: 'record',
    reason:
      'Inconclusive: a transient RPC failure proves nothing about the trade, and the coverage control already holds the cursor on it.',
  },
  INDEXER_SURPLUS_RECORDS: {
    outcome: 'record',
    reason: 'A whole-projection count, not attributable to one trade, so it cannot scope a pause.',
  },
  STATUS_MISMATCH: {
    outcome: 'record',
    reason: 'A lifecycle-lag shape that resolves as the projection catches up.',
  },
  ARRIVAL_TIMESTAMP_MISMATCH: {
    outcome: 'record',
    reason: 'A lifecycle-lag shape that resolves as the projection catches up.',
  },
  INDEXED_INVALID_ADDRESS: {
    outcome: 'record',
    reason:
      'An unusable value rather than a proven disagreement; a real party divergence surfaces as PARTICIPANT_MISMATCH.',
  },
  ONCHAIN_INVALID_ADDRESS: {
    outcome: 'record',
    reason:
      'An unusable value rather than a proven disagreement; a real party divergence surfaces as PARTICIPANT_MISMATCH.',
  },
  INDEXER_DUPLICATE_TRADE: {
    outcome: 'record',
    reason:
      'A projection integrity defect; the per-trade comparisons on the duplicated trade decide containment.',
  },
});

/** Every discrepancy code, in rule-set order. */
export const DRIFT_CODES = Object.freeze(Object.keys(RISK_RULES_V1) as DriftCode[]);

export function riskOutcome(code: DriftCode): RiskOutcome {
  return RISK_RULES_V1[code].outcome;
}

/**
 * SHA-256 of the rule set's canonical form: each code and its outcome, sorted
 * by code, under the version. Carried with containment evidence so an incident
 * names the exact rules that opened it. The reasons are documentation and are
 * not part of the digest.
 */
export const RISK_RULES_V1_DIGEST = createHash('sha256')
  .update(
    JSON.stringify({
      version: RISK_RULES_VERSION,
      rules: [...DRIFT_CODES].sort().map((code) => [code, RISK_RULES_V1[code].outcome]),
    }),
  )
  .digest('hex');
