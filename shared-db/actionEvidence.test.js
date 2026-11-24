'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./fixtures/reconciliation-proof.v1.json');
const { attestActionEvidence, verifyActionEvidence } = require('./actionEvidence');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signer = {
  keyId: 'lookup-key',
  sign: async (bytes) => crypto.sign('sha256', bytes, privateKey),
};
const options = {
  challenge: 'a'.repeat(64),
  resource: '/containments/2001/recovery',
  context: fixture.context,
  publicKeys: new Map([[signer.keyId, publicKey]]),
  now: Date.now(),
};
const body = { ...fixture.proof.recovery };
test('a nonce-bound server response authenticates its exact snapshot', async () => {
  const response = await attestActionEvidence(body, { ...options, signer });
  assert.equal(verifyActionEvidence(response, options), true);
  for (const change of [
    { challenge: 'b'.repeat(64) },
    { resource: '/containments/2002/recovery' },
    { context: { ...fixture.context, chainId: 1 } },
    { publicKeys: new Map() },
    { now: options.now + 30001 },
    { now: options.now - 5001 },
  ])
    assert.equal(verifyActionEvidence(response, { ...options, ...change }), false);
});
test('missing, malformed, tampered and replayed attestations fail closed', async () => {
  const response = await attestActionEvidence(body, { ...options, signer });
  assert.equal(verifyActionEvidence(body, options), false);
  assert.equal(verifyActionEvidence(null, options), false);
  assert.equal(verifyActionEvidence({ ...response, tradeId: 'forged' }, options), false);
  assert.equal(
    verifyActionEvidence(
      { ...response, attestation: { ...response.attestation, signature: 'AAAA' } },
      options,
    ),
    false,
  );
  assert.equal(verifyActionEvidence(response, { ...options, challenge: 'c'.repeat(64) }), false);
});
