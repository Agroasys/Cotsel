'use strict';

// Review R01/R02/R03, decisions Q1/Q2: each probe from the review is a case
// here, built from real signed manifests, never from hand-set verdicts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  buildRunManifest,
  findingDigest,
  manifestBytes,
  parsePublicKeys,
  verifyContainmentBundle,
} = require('./reconciliationEvidence');
const {
  RISK_RULE_SETS,
  ruleSetDigest,
  verifyContainmentRecovery,
} = require('./containmentRecovery');

const RULES = 'cotsel.reconciliation-risk-rules.v1';
const CONTEXT = { chainId: 84532, escrowAddress: '0xabc0000000000000000000000000000000000001' };
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_ID = 'test-key';
const KEYS = parsePublicKeys(
  JSON.stringify({
    [KEY_ID]: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }),
);
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const at = (minutesAgo) =>
  new Date(NOW - minutesAgo * 60_000).toISOString().replace('Z', '').padEnd(26, '0');

const drift = (runKey, tradeId, indexedValue, mismatchCode = 'AMOUNT_MISMATCH') => ({
  runKey,
  tradeId,
  severity: 'CRITICAL',
  mismatchCode,
  comparedField: 'totalAmountLocked',
  onchainValue: '100',
  indexedValue,
  details: {},
});

/** A sealed run: evidence rows plus a manifest signed like reconciliation signs it. */
function sealedRun(
  runKey,
  {
    minutesAgo,
    findings = [],
    containments = [],
    clearances = [],
    context = CONTEXT,
    scopeTradeIds = ['7', '8'],
    rulesDigest = ruleSetDigest(RULES),
  },
) {
  const evidence = {
    runKey,
    status: 'COMPLETED',
    completedAt: at(minutesAgo),
    coverage: { fromBlock: '1', toBlock: '2', complete: true, fromTradeId: '1', toTradeId: '9' },
    findings,
    scopeTradeIds,
  };
  const manifest = buildRunManifest(evidence, {
    keyId: KEY_ID,
    rulesVersion: RULES,
    rulesDigest,
    sealed: { containments, clearances, context },
  });
  const signature = crypto.sign('sha256', manifestBytes(manifest), privateKey).toString('base64');
  return { runKey, seal: { manifest, signature, keyId: KEY_ID }, evidence };
}

const entry = (overrides = {}) => ({
  tradeId: '7',
  incidentReference: 'RECON-20261124-AAAA0001',
  episode: 1,
  state: 'RECONCILED_PENDING_APPROVAL',
  openedRunKey: 'run-a',
  clearedRunKey: 'run-c',
  citedFindings: [{ runKey: 'run-a', digest: findingDigest(drift('run-a', '7', '101')) }],
  ...overrides,
});
const clearance = { tradeId: '7', incidentReference: 'RECON-20261124-AAAA0001', episode: 1 };

/** A → C: opened by run-a, cleared by run-c, latest = run-c. */
function recovered({
  latestEntry = entry(),
  clearingFindings = [],
  clearingClearances = [clearance],
  clearingAge = 10,
} = {}) {
  const runA = sealedRun('run-a', { minutesAgo: 60, findings: [drift('run-a', '7', '101')] });
  const runC = sealedRun('run-c', {
    minutesAgo: clearingAge,
    findings: clearingFindings,
    containments: [latestEntry],
    clearances: clearingClearances,
  });
  return { tradeId: '7', latest: runC, runs: { 'run-a': runA, 'run-c': runC } };
}

const verify = (bundle, extra = {}) =>
  verifyContainmentRecovery(bundle, {
    publicKeys: KEYS,
    context: CONTEXT,
    maxAgeSeconds: 3600,
    now: NOW,
    expectedTradeId: '7',
    matchesIncident: (reference) => reference === 'RECON-20261124-AAAA0001',
    ...extra,
  });

test('the shared rule set equals what reconciliation contains on', () => {
  assert.equal(ruleSetDigest(RULES).length, 64);
  assert.ok(RISK_RULE_SETS[RULES].contain.includes('AMOUNT_MISMATCH'));
  assert.ok(!RISK_RULE_SETS[RULES].contain.includes('STATUS_MISMATCH'));
});

test('Q2: a verified, cleared incident for the proposal is recovered', () => {
  const result = verify(recovered());
  assert.equal(result.decision, 'reconciliation_recovery_verified');
  assert.equal(result.evidence.clearedRunKey, 'run-c');
  assert.match(result.evidence.manifestDigest, /^[0-9a-f]{64}$/);
});

test('probe: a still-contained trade is refused', () => {
  const result = verify(
    recovered({ latestEntry: entry({ state: 'CONTAINED', clearedRunKey: null }) }),
  );
  assert.deepEqual([result.decision, result.reason], ['refused', 'containment_not_cleared']);
});

test("probe: another incident's reference is refused", () => {
  const result = verify(recovered(), {
    matchesIncident: (reference) => reference === 'RECON-OTHER',
  });
  assert.equal(result.reason, 'incident_mismatch');
});

test('probe: a finding of another trade cannot be cited for this one', () => {
  const otherTrade = entry({
    citedFindings: [{ runKey: 'run-a', digest: findingDigest(drift('run-a', '8', '101')) }],
  });
  const runA = sealedRun('run-a', {
    minutesAgo: 60,
    findings: [drift('run-a', '7', '101'), drift('run-a', '8', '101')],
  });
  const bundle = recovered({ latestEntry: otherTrade });
  bundle.runs['run-a'] = runA;
  assert.equal(verify(bundle).detail, 'cited_finding_other_trade');
});

test('probe: swapping the trade in a relayed bundle breaks verification', () => {
  const bundle = recovered();
  bundle.latest = structuredClone(bundle.latest);
  bundle.latest.seal.manifest.containments[0].tradeId = '8';
  assert.equal(
    verify({ ...bundle, tradeId: '8' }, { expectedTradeId: '8' }).detail,
    'latest_bad_signature',
  );
});

test('probe: a clearing run with a qualifying finding for the trade is refused', () => {
  const result = verify(recovered({ clearingFindings: [drift('run-c', '7', '105')] }));
  assert.deepEqual(
    [result.reason, result.detail],
    ['clearance_invalid', 'clearing_run_has_qualifying_finding'],
  );
});

test('probe: a clearing run that did not cover the trade asserts no clearance', () => {
  const result = verify(recovered({ clearingClearances: [] }));
  assert.deepEqual([result.reason, result.detail], ['clearance_invalid', 'clearance_not_asserted']);
});

test('probe: a clearing run older than the divergence is refused', () => {
  const runA = sealedRun('run-a', { minutesAgo: 5, findings: [drift('run-a', '7', '101')] });
  const bundle = recovered({ clearingAge: 10 });
  bundle.runs['run-a'] = runA;
  assert.equal(verify(bundle).detail, 'clearance_predates_divergence');
});

test('R03: A opens, B repeats, C clears — both cited runs verify; D diverging again blocks', () => {
  const findingA = drift('run-a', '7', '101');
  const findingB = drift('run-b', '7', '102');
  const cited = [
    { runKey: 'run-a', digest: findingDigest(findingA) },
    { runKey: 'run-b', digest: findingDigest(findingB) },
  ];
  const runA = sealedRun('run-a', { minutesAgo: 60, findings: [findingA] });
  const runB = sealedRun('run-b', { minutesAgo: 40, findings: [findingB] });
  const cleared = entry({ citedFindings: cited });
  const runC = sealedRun('run-c', {
    minutesAgo: 20,
    containments: [cleared],
    clearances: [clearance],
  });
  const bundle = {
    tradeId: '7',
    latest: runC,
    runs: { 'run-a': runA, 'run-b': runB, 'run-c': runC },
  };
  assert.equal(verify(bundle).decision, 'reconciliation_recovery_verified');

  const findingD = drift('run-d', '7', '103');
  const runD = sealedRun('run-d', {
    minutesAgo: 5,
    findings: [findingD],
    containments: [
      entry({
        state: 'CONTAINED',
        clearedRunKey: null,
        citedFindings: [...cited, { runKey: 'run-d', digest: findingDigest(findingD) }],
      }),
    ],
  });
  const afterD = verify({ ...bundle, latest: runD, runs: { ...bundle.runs, 'run-d': runD } });
  assert.equal(afterD.reason, 'containment_not_cleared');
});

test('a released trade that diverges again: the old clearance does not match the new episode', () => {
  const reopened = entry({ episode: 2, incidentReference: 'RECON-20261124-AAAA0001' });
  // Clearance recorded for episode 1 only.
  const result = verify(recovered({ latestEntry: reopened }));
  assert.equal(result.detail, 'clearance_not_asserted');
});

test('stale evidence is refused with its own reason', () => {
  const result = verify(recovered({ clearingAge: 120 }));
  assert.equal(result.reason, 'reconciliation_evidence_stale');
});

test('evidence for another chain or escrow is refused', () => {
  const result = verify(recovered(), { context: { ...CONTEXT, escrowAddress: '0xdef' } });
  assert.equal(result.detail, 'context_mismatch');
});

test('Q1: a fresh signed state without the trade allows the normal quorum unpause', () => {
  const latest = sealedRun('run-z', { minutesAgo: 5, containments: [entry({ tradeId: '8' })] });
  const bundle = { tradeId: '7', latest, runs: {} };
  assert.equal(verify(bundle).decision, 'no_reconciliation_containment');
  // ...unless the proposal names a reconciliation incident.
  assert.equal(
    verify(bundle, { incidentIsReconciliation: true }).reason,
    'reconciliation_incident_without_containment',
  );
});

test('missing or unverifiable evidence never establishes the exemption', () => {
  assert.equal(verify({ tradeId: '7' }).reason, 'reconciliation_evidence_invalid');
  const unsigned = recovered();
  unsigned.latest = { ...unsigned.latest, seal: { ...unsigned.latest.seal, keyId: 'unknown' } };
  assert.equal(verify(unsigned).reason, 'reconciliation_evidence_invalid');
});

test('a response for another requested trade never establishes an exemption', () => {
  const bundle = recovered();
  bundle.tradeId = '8';
  assert.equal(verify(bundle).detail, 'requested_trade_mismatch');
});

test('a signed future snapshot cannot extend evidence freshness', () => {
  const latest = sealedRun('future', { minutesAgo: -10 });
  assert.equal(verify({ tradeId: '7', latest, runs: {} }).reason, 'reconciliation_evidence_stale');
});

test('clearance must prove that the exact trade was in the compared scope', () => {
  const bundle = recovered();
  const clearing = sealedRun('run-c', {
    minutesAgo: 10,
    containments: [entry()],
    clearances: [clearance],
    scopeTradeIds: ['8'],
  });
  bundle.latest = clearing;
  bundle.runs['run-c'] = clearing;
  assert.equal(verify(bundle).detail, 'clearing_trade_not_in_scope');
});

test('clearance cannot use an unknown definition of otherwise named rules', () => {
  const bundle = recovered();
  const clearing = sealedRun('run-c', {
    minutesAgo: 10,
    containments: [entry()],
    clearances: [clearance],
    rulesDigest: '0'.repeat(64),
  });
  bundle.latest = clearing;
  bundle.runs['run-c'] = clearing;
  assert.equal(verify(bundle).detail, 'unknown_rules');
});

test('malformed snapshots return a refusal rather than throwing', () => {
  const latest = sealedRun('malformed', { minutesAgo: 1, containments: [null] });
  assert.doesNotThrow(() => verify({ tradeId: '7', latest, runs: {} }));
  assert.equal(verify({ tradeId: '7', latest, runs: {} }).decision, 'refused');
});

test('display verification binds the row to signed incident state and every cited run', () => {
  const recovery = recovered();
  const bundle = {
    containment: {
      trade_id: '7',
      incident_reference: clearance.incidentReference,
      state: 'RECONCILED_PENDING_APPROVAL',
      opened_run_key: 'run-a',
      cleared_run_key: 'run-c',
      evidence: { findings: [{ digest: entry().citedFindings[0].digest }] },
    },
    opening: recovery.runs['run-a'],
    clearing: recovery.runs['run-c'],
    recovery,
  };
  assert.equal(verifyContainmentBundle(bundle, KEYS).evidence.status, 'verified');
  assert.equal(
    verifyContainmentBundle(
      { ...bundle, containment: { ...bundle.containment, incident_reference: 'RECON-FORGED' } },
      KEYS,
    ).evidence.status,
    'failed',
  );
});

test('Q1 refuses unknown rules even on a fresh signed absence snapshot', () => {
  const latest = sealedRun('unknown-rules', { minutesAgo: 1 });
  latest.seal.manifest.rules = { version: 'unknown-rules-v999', digest: '0'.repeat(64) };
  latest.seal.signature = crypto
    .sign('sha256', manifestBytes(latest.seal.manifest), privateKey)
    .toString('base64');
  assert.deepEqual(verify({ tradeId: '7', latest, runs: {} }), {
    decision: 'refused',
    reason: 'reconciliation_evidence_invalid',
    detail: 'unknown_rules',
  });
});
