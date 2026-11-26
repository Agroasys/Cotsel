'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/reconciliation-proof.v1.json');
const { parsePublicKeys } = require('./reconciliationEvidence');
const { buildFreezeRequest, verifyFreezeRequestBundle } = require('./freezeRequests');
const keys = parsePublicKeys(JSON.stringify(fixture.keys));
const opening = fixture.proof.opening.seal.manifest;
const request = () => buildFreezeRequest(opening, opening.containments[0]);

test('a durable freeze request names the exact signed incident and requires human approval', () => {
  const value = request();
  assert.match(value.requestId, /^[a-f0-9]{64}$/);
  assert.equal(value.tradeId, '2001');
  assert.equal(value.requiresGovernanceApproval, true);
  assert.deepEqual(value.findings, opening.containments[0].citedFindings);
  assert.equal(
    verifyFreezeRequestBundle({ request: value, proof: fixture.proof }, keys, fixture.context).ok,
    true,
  );
});

test('a forged request cannot borrow valid evidence of another trade or incident', () => {
  for (const field of ['tradeId', 'incidentReference', 'requestId']) {
    assert.equal(
      verifyFreezeRequestBundle(
        { request: { ...request(), [field]: 'forged' }, proof: fixture.proof },
        keys,
        fixture.context,
      ).ok,
      false,
    );
  }
});

test('tampered findings and untrusted signing keys never approve a freeze request', () => {
  assert.equal(
    verifyFreezeRequestBundle(
      { request: request(), proof: fixture.tamperedProof },
      keys,
      fixture.context,
    ).ok,
    false,
  );
  assert.equal(
    verifyFreezeRequestBundle(
      { request: request(), proof: fixture.proof },
      new Map(),
      fixture.context,
    ).ok,
    false,
  );
});
