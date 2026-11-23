import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { SignCommand } from '@aws-sdk/client-kms';
import {
  createFindingSigner,
  createKmsFindingSigner,
  createLocalFindingSigner,
  FindingSigningError,
  localPublicKeyDerBase64,
} from '../core/findingSigner';
import { loadConfig } from '../config';
import { BASE_TEST_ENV } from './helpers/reconciliationEnv';

// Raw P-256 signing over a digest, as KMS does for MessageType=DIGEST. Node's
// crypto always hashes its input, so it cannot stand in for KMS here.
const { p256 } = createRequire(require.resolve('ethers'))('@noble/curves/p256') as {
  p256: { sign(digest: Uint8Array, key: Uint8Array): { toDERRawBytes(): Uint8Array } };
};

const MESSAGE = Buffer.from(
  '{"runKey":"daemon-1","schemaVersion":"cotsel.reconciliation-run-manifest.v1"}',
);

test('a KMS digest signature verifies exactly like a local signature over the message', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const d = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const sent: SignCommand['input'][] = [];
  const kms = {
    send: async (command: SignCommand) => {
      sent.push(command.input);
      return { Signature: p256.sign(command.input.Message as Uint8Array, d).toDERRawBytes() };
    },
  };
  const signature = await createKmsFindingSigner('arn:aws:kms:test:key/1', 5000, kms as never).sign(
    MESSAGE,
  );
  assert.deepEqual(sent, [
    {
      KeyId: 'arn:aws:kms:test:key/1',
      Message: createHash('sha256').update(MESSAGE).digest(),
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    },
  ]);
  assert.equal(verify('sha256', MESSAGE, publicKey, signature), true);
  assert.equal(verify('sha256', Buffer.from('tampered'), publicKey, signature), false);
});

test('a KMS outage or a slow KMS is a signing failure, never an unsigned run', async () => {
  const down = { send: async () => Promise.reject(new Error('AccessDeniedException')) };
  await assert.rejects(
    createKmsFindingSigner('k', 5000, down as never).sign(MESSAGE),
    (error: unknown) =>
      error instanceof FindingSigningError && /could not sign/u.test(error.message),
  );
  const hung = { send: () => new Promise(() => undefined) };
  await assert.rejects(
    createKmsFindingSigner('k', 50, hung as never).sign(MESSAGE),
    (error: unknown) => error instanceof FindingSigningError && /timed out/u.test(error.message),
  );
  const empty = { send: async () => ({ Signature: new Uint8Array() }) };
  await assert.rejects(
    createKmsFindingSigner('k', 5000, empty as never).sign(MESSAGE),
    FindingSigningError,
  );
});

test('the local signer accepts only a P-256 PKCS#8 key and signs verifiably', async () => {
  const signer = createLocalFindingSigner('test', BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY);
  const publicKey = Buffer.from(
    localPublicKeyDerBase64(BASE_TEST_ENV.RECONCILIATION_FINDING_SIGNING_KEY),
    'base64',
  );
  const signature = await signer.sign(MESSAGE);
  assert.equal(
    verify('sha256', MESSAGE, { key: publicKey, format: 'der', type: 'spki' }, signature),
    true,
  );

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(
    () =>
      createLocalFindingSigner(
        'x',
        rsa.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      ),
    /must be an ECDSA P-256 key/u,
  );
  assert.throws(() => createLocalFindingSigner('x', 'bm90IGEga2V5'), /not a PKCS#8 key/u);
});

test('no configured signer refuses to start rather than publish unsigned findings', () => {
  assert.throws(() => createFindingSigner(null, 5000), /never published unsigned/u);
});

test('local signing is refused outside the local profile', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { COTSEL_ENVIRONMENT: 'staging', NODE_ENV: 'production' });
    assert.throws(() => loadConfig(), /RECONCILIATION_FINDING_SIGNER=local is refused/u);
    process.env.RECONCILIATION_FINDING_SIGNER = 'kms:arn:aws:kms:eu-west-1:1:key/abc';
    assert.deepEqual(loadConfig().findingSigner, {
      mode: 'kms',
      keyId: 'arn:aws:kms:eu-west-1:1:key/abc',
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the signer setting names a mode and a key id', () => {
  const saved = { ...process.env };
  try {
    for (const bad of ['kms', 'kms:', 'local', 'vault:key']) {
      process.env.RECONCILIATION_FINDING_SIGNER = bad;
      assert.throws(() => loadConfig(), /must be kms:<key id> or local:<label>/u, bad);
    }
  } finally {
    Object.assign(process.env, saved);
  }
});
