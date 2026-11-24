import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUALIFYING_DISCREPANCY_CODES,
  isQualifyingDiscrepancy,
  qualifyDiscrepancies,
} from '../core/containment';
import {
  DRIFT_CODES,
  RISK_RULES_V1,
  RISK_RULES_V1_DIGEST,
  RISK_RULES_VERSION,
  riskOutcome,
} from '../core/riskRules';
import type { DriftCode, DriftFinding } from '../types';

// The qualification exactly as it was hard-coded before the versioned rules
// (containment.ts at 8c22124), written out so the equivalence is checked
// against the old behaviour rather than against itself.
const PREVIOUS_QUALIFYING_CODES = [
  'AMOUNT_MISMATCH',
  'FEE_COMPONENT_MISMATCH',
  'PARTICIPANT_MISMATCH',
  'HASH_MISMATCH',
  'ONCHAIN_TRADE_MISSING',
  'INDEXER_TRADE_MISSING',
];
const EVERY_DRIFT_CODE = [
  'ONCHAIN_READ_ERROR',
  'ONCHAIN_TRADE_MISSING',
  'STATUS_MISMATCH',
  'PARTICIPANT_MISMATCH',
  'AMOUNT_MISMATCH',
  'FEE_COMPONENT_MISMATCH',
  'HASH_MISMATCH',
  'ARRIVAL_TIMESTAMP_MISMATCH',
  'INDEXED_INVALID_ADDRESS',
  'ONCHAIN_INVALID_ADDRESS',
  'INDEXER_TRADE_MISSING',
  'INDEXER_DUPLICATE_TRADE',
  'INDEXER_SURPLUS_RECORDS',
];

function finding(tradeId: string, mismatchCode: DriftCode): DriftFinding {
  return {
    tradeId,
    severity: 'CRITICAL',
    mismatchCode,
    comparedField: 'field',
    onchainValue: null,
    indexedValue: null,
    details: {},
  };
}

test('the rule set decides an outcome for every discrepancy code', () => {
  assert.deepEqual([...DRIFT_CODES].sort(), [...EVERY_DRIFT_CODE].sort());
});

test('v1 rules contain exactly the codes the hard-coded qualification contained', () => {
  for (const code of DRIFT_CODES) {
    const previously = PREVIOUS_QUALIFYING_CODES.includes(code);
    assert.equal(riskOutcome(code) === 'contain', previously, code);
    assert.equal(isQualifyingDiscrepancy(finding('1', code)), previously, code);
  }
  assert.deepEqual([...QUALIFYING_DISCREPANCY_CODES].sort(), [...PREVIOUS_QUALIFYING_CODES].sort());
});

test('grouping by trade is unchanged under the rules', () => {
  const grouped = qualifyDiscrepancies(
    DRIFT_CODES.flatMap((code, index) => [finding(String(index % 3), code)]),
  );
  for (const group of grouped) {
    assert.ok(group.codes.every((code) => PREVIOUS_QUALIFYING_CODES.includes(code)));
  }
  assert.equal(
    grouped.reduce((total, group) => total + group.findings.length, 0),
    PREVIOUS_QUALIFYING_CODES.length,
  );
});

test('a published rule version never changes', () => {
  // Changing an outcome needs a new RISK_RULES_VERSION, not an edit of v1.
  assert.equal(RISK_RULES_VERSION, 'cotsel.reconciliation-risk-rules.v1');
  assert.equal(
    RISK_RULES_V1_DIGEST,
    'e00f84b6d9f48aade161ff3dbe6433eb10310ecc7c6da763aa429773884578c3',
  );
  assert.ok(Object.isFrozen(RISK_RULES_V1));
});

// Verifiers outside reconciliation (the gateway, Dash) decide on the copy in
// @agroasys/shared-db/containmentRecovery; it must stay this rule set exactly.
test('the shared verifier copy of the rules equals RISK_RULES_V1 and its digest', async () => {
  const { RISK_RULE_SETS, ruleSetDigest } = await import('@agroasys/shared-db/containmentRecovery');
  const shared = RISK_RULE_SETS[RISK_RULES_VERSION];
  assert.ok(shared);
  assert.deepEqual(
    [...shared.contain].sort(),
    DRIFT_CODES.filter((code) => RISK_RULES_V1[code].outcome === 'contain').sort(),
  );
  assert.deepEqual(
    [...shared.record].sort(),
    DRIFT_CODES.filter((code) => RISK_RULES_V1[code].outcome === 'record').sort(),
  );
  assert.equal(ruleSetDigest(RISK_RULES_VERSION), RISK_RULES_V1_DIGEST);
});
