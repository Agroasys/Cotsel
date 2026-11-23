'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  classifyRunFindings,
  buildRunManifest,
  canonicalJson,
  findingDigest,
  manifestBytes,
  parsePublicKeys,
  scopeDigest,
} = require('./reconciliationEvidence');

const finding = {
  runKey: 'daemon-1',
  tradeId: '7',
  severity: 'CRITICAL',
  mismatchCode: 'AMOUNT_MISMATCH',
  comparedField: 'totalAmountLocked',
  onchainValue: '100',
  indexedValue: '101',
  details: { b: 2, a: null, c: true },
};

test('canonical JSON sorts keys at every depth and rejects what JSON cannot carry', () => {
  assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: 'x' }), '{"a":"x","b":[{"c":2,"d":1}]}');
  assert.throws(() => canonicalJson({ a: 1n }), TypeError);
  assert.throws(() => canonicalJson({ a: Number.NaN }), TypeError);
});

test('a finding digest ignores key order but not content', () => {
  const reordered = { ...finding, details: { c: true, a: null, b: 2 } };
  assert.equal(findingDigest(reordered), findingDigest(finding));
  assert.notEqual(findingDigest({ ...finding, indexedValue: '100' }), findingDigest(finding));
  assert.notEqual(findingDigest({ ...finding, runKey: 'daemon-2' }), findingDigest(finding));
  assert.equal(scopeDigest(['2', '1']), scopeDigest(['1', '2']));
});

test('a manifest signs to bytes that a P-256 public key verifies', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const manifest = buildRunManifest(
    {
      runKey: 'daemon-1',
      status: 'COMPLETED',
      completedAt: '2026-11-23T10:00:00.000000',
      coverage: { fromBlock: '0', toBlock: '9', complete: true, fromTradeId: '0', toTradeId: '9' },
      findings: [finding],
      scopeTradeIds: ['7', '8'],
    },
    { keyId: 'k', rulesVersion: 'v1', rulesDigest: 'd' },
  );
  assert.deepEqual(manifest.findings, { count: 1, digests: [findingDigest(finding)] });
  const signature = crypto.sign('sha256', manifestBytes(manifest), privateKey);
  assert.equal(crypto.verify('sha256', manifestBytes(manifest), publicKey, signature), true);
});

test('only ECDSA P-256 verification keys are accepted', () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  const keys = parsePublicKeys(
    JSON.stringify({ k: ec.export({ format: 'der', type: 'spki' }).toString('base64') }),
  );
  assert.deepEqual([...keys.keys()], ['k']);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.throws(
    () =>
      parsePublicKeys(
        JSON.stringify({ k: rsa.export({ format: 'der', type: 'spki' }).toString('base64') }),
      ),
    /ECDSA P-256/u,
  );
  assert.throws(() => parsePublicKeys('[]'), /JSON object/u);
  assert.throws(() => parsePublicKeys('not json'), /JSON object/u);
});

test('a signature that does not verify marks every finding failed', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  const evidence = {
    runKey: 'daemon-1',
    status: 'COMPLETED',
    completedAt: '2026-11-24T10:00:00.000000',
    coverage: { fromBlock: '0', toBlock: '9', complete: true, fromTradeId: '0', toTradeId: '9' },
    findings: [finding],
    scopeTradeIds: ['7'],
  };
  const manifest = buildRunManifest(evidence, { keyId: 'k', rulesVersion: 'v1', rulesDigest: 'd' });
  const signature = crypto.sign('sha256', manifestBytes(manifest), privateKey).toString('base64');
  const row = {
    trade_id: finding.tradeId,
    severity: finding.severity,
    mismatch_code: finding.mismatchCode,
    compared_field: finding.comparedField,
    onchain_value: finding.onchainValue,
    indexed_value: finding.indexedValue,
    details: finding.details,
  };
  const db = {
    async query(text) {
      if (/FROM reconcile_run_manifests/u.test(text)) {
        return { rows: [{ manifest, signature, key_id: 'k' }] };
      }
      if (/FROM reconcile_runs/u.test(text)) {
        return {
          rows: [
            {
              run_key: 'daemon-1',
              status: 'COMPLETED',
              completed_at: evidence.completedAt,
              coverage_from_block: '0',
              coverage_to_block: '9',
              coverage_complete: true,
              coverage_from_trade_id: '0',
              coverage_to_trade_id: '9',
            },
          ],
        };
      }
      if (/FROM reconcile_drifts/u.test(text)) return { rows: [row] };
      return { rows: [{ trade_id: '7' }] };
    },
  };
  const wrongKey = parsePublicKeys(
    JSON.stringify({ k: other.export({ format: 'der', type: 'spki' }).toString('base64') }),
  );
  const result = await classifyRunFindings(db, 'daemon-1', wrongKey);
  assert.equal(result.run.reason, 'bad_signature');
  assert.deepEqual(
    result.findings.map((entry) => entry.status),
    ['failed'],
  );
});
