import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const store = path.resolve('node_modules/.pnpm');
function installed(name, version) {
  const entries = fs
    .readdirSync(store)
    .filter((entry) => entry === `${name}@${version}` || entry.startsWith(`${name}@${version}_`));
  assert.equal(entries.length, 1, `Expected one installed ${name}@${version}`);
  return path.join(store, entries[0], 'node_modules', name);
}

// Public test vector, never a live key. Source: elliptic PR 322, comment 2463004218.
const p521PrivateKey =
  '01535d22d63de9195efd4c41358ddc89c68b6cc202b558fbf48a09e95dddf953afc1b4cfed6df0f3330f986735085e367fd07030c3ab49dcd3461197b00f09a064fb';
const p521Expected =
  '308188024201e92eeaf15414d4af3ee933825131867b6cb10234f28336ac976a' +
  '99127139f23100458a9ee7184bfa64540ba385331eb3b469f491b3da013c42ad' +
  '154a5907f554f0024200db3703c6d51b8a85c10c21b7643fe751781a7ad5708e' +
  '3a944107f6da086afdc8532765871a9cabc81cec0f5b28ee59f0c72b48b72a39' +
  'ae2d230dfb03afb9968a94';

test('elliptic preserves the byte length of a leading-zero RFC 6979 nonce', () => {
  const { ec: EC } = require(installed('elliptic', '6.6.1'));
  const ec = new EC('p521');
  const key = ec.keyFromPrivate(p521PrivateKey);
  const message = Buffer.from('12f830e9591916ec', 'hex');
  const signature = key.sign(createHash('sha512').update(message).digest());
  assert.equal(signature.toDER('hex'), p521Expected);
  // OpenSSL independently verifies the result over the original message.
  const publicKey = key.getPublic();
  const nativeKey = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-521',
      x: Buffer.from(publicKey.getX().toArray('be', 66)).toString('base64url'),
      y: Buffer.from(publicKey.getY().toArray('be', 66)).toString('base64url'),
    },
  });
  assert.equal(verify('sha512', message, nativeKey, Buffer.from(signature.toDER())), true);
});

test('elliptic retains the Ethereum secp256k1 signature and custom nonce APIs', async () => {
  const { SigningKey } = await import('ethers');
  const { ec: EC } = require(installed('elliptic', '6.6.1'));
  const ec = new EC('secp256k1');
  const privateKey = '12'.repeat(32);
  const digest = createHash('sha256').update('Cotsel dependency compatibility').digest();
  const signature = ec.sign(digest, privateKey, { canonical: true });
  const independent = new SigningKey(`0x${privateKey}`).sign(`0x${digest.toString('hex')}`);
  assert.equal(signature.r.toString(16, 64), independent.r.slice(2));
  assert.equal(signature.s.toString(16, 64), independent.s.slice(2));
  const key = ec.keyFromPrivate(privateKey);
  const custom = key.sign(digest, { k: () => key.getPrivate().clone() });
  assert.equal(ec.verify(digest, custom, key), true);
  // Exercise the real secp256k1 fallback used by the Hardhat dependency chain.
  const fallback = require(path.join(installed('secp256k1', '4.0.4'), 'elliptic.js'));
  const nativeFormat = fallback.ecdsaSign(digest, Buffer.from(privateKey, 'hex'));
  assert.equal(
    Buffer.from(nativeFormat.signature).toString('hex'),
    independent.r.slice(2) + independent.s.slice(2),
  );
  assert.equal(
    fallback.ecdsaVerify(
      nativeFormat.signature,
      digest,
      fallback.publicKeyCreate(Buffer.from(privateKey, 'hex')),
    ),
    true,
  );
});

test('all installed elliptic and deepmerge consumers resolve the patched artifacts', () => {
  for (const name of ['elliptic', 'deepmerge']) {
    let consumers = 0;
    for (const entry of fs.readdirSync(store)) {
      const link = path.join(store, entry, 'node_modules', name);
      let stat;
      try {
        stat = fs.lstatSync(link);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw error;
      }
      if (!stat.isSymbolicLink()) continue;
      assert.match(fs.realpathSync(link), /_patch_hash=/);
      consumers++;
    }
    assert.ok(consumers > 0, `No ${name} consumers checked`);
  }
});

for (const entry of ['dist/cjs.js', 'dist/umd.js']) {
  test(`deepmerge ${entry} blocks prototype injection through both input loops`, () => {
    const merge = require(path.join(installed('deepmerge', '4.3.1'), entry));
    const poison = JSON.parse(
      '{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}},"prototype":{"isAdmin":true},"name":"safe"}',
    );
    for (const target of [
      Object.create(null),
      { session: null },
      { session: 0 },
      JSON.parse('{"__proto__":null}'),
      JSON.parse('{"__proto__":{"existing":true}}'),
    ]) {
      for (const options of [{}, { clone: false }]) {
        const result = merge(target, poison, options);
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(result.isAdmin, undefined);
        for (const key of ['__proto__', 'constructor', 'prototype'])
          assert.equal(Object.hasOwn(result, key), false);
        assert.equal(result.name, 'safe');
      }
    }
    const nested = merge({ session: null }, { session: poison });
    assert.equal(Object.getPrototypeOf(nested.session), Object.prototype);
    assert.equal(nested.session.isAdmin, undefined);
    const copied = merge(poison, {});
    assert.equal(Object.getPrototypeOf(copied), Object.prototype);
    assert.equal(copied.isAdmin, undefined);
    const throwingTarget = new Proxy(
      {},
      {
        has() {
          throw new Error('unsafe target');
        },
      },
    );
    assert.deepEqual(merge(throwingTarget, { role: 'admin' }), {});
    assert.equal({}.isAdmin, undefined);
  });

  test(`deepmerge ${entry} retains nested, array, symbol and custom merge behavior`, () => {
    const merge = require(path.join(installed('deepmerge', '4.3.1'), entry));
    const symbol = Symbol('configuration');
    const original = { nested: { left: 1 }, items: [1], [symbol]: { left: true } };
    const result = merge(original, { nested: { right: 2 }, items: [2], [symbol]: { right: true } });
    assert.deepEqual(result, {
      nested: { left: 1, right: 2 },
      items: [1, 2],
      [symbol]: { left: true, right: true },
    });
    assert.deepEqual(original.items, [1]);
    assert.deepEqual(merge.all([{ nested: { left: 1 } }, { nested: { right: 2 } }]), {
      nested: { left: 1, right: 2 },
    });
    assert.deepEqual(
      merge({ items: [1] }, { items: [2] }, { arrayMerge: (_left, right) => right }),
      { items: [2] },
    );
    assert.deepEqual(
      merge({ name: { left: 1 } }, { name: { right: 2 } }, { customMerge: () => () => 'custom' }),
      { name: 'custom' },
    );
  });
}

test('legacy stream-json has no JSONC entry points and rejects chunked comments', async () => {
  const directory = installed('stream-json', '1.9.1');
  const files = fs
    .readdirSync(directory, { recursive: true })
    .filter((name) => /\.(js|json)$/.test(name))
    .sort();
  const sourceHash = createHash('sha256');
  for (const name of files) {
    sourceHash.update(name.split(path.sep).join('/') + '\0');
    sourceHash.update(fs.readFileSync(path.join(directory, name)));
    sourceHash.update('\0');
  }
  assert.equal(files.length, 23);
  assert.equal(
    sourceHash.digest('hex'),
    '94a3b9173380e36feae352cc2c134d1228210e94cbc6ea374a51d2723dd7471c',
  );
  for (const entry of [
    'jsonc/parser.js',
    'jsonc/verifier.js',
    'jsonc/Parser.js',
    'jsonc/Verifier.js',
  ]) {
    assert.throws(() => require.resolve(path.join(directory, entry)), { code: 'MODULE_NOT_FOUND' });
  }
  const Parser = require(path.join(directory, 'Parser.js'));
  const Verifier = require(path.join(directory, 'utils/Verifier.js'));
  for (const input of ['/*' + 'a'.repeat(4096) + '*/1', '//' + 'a'.repeat(4096) + '\n1']) {
    const chunks = Array.from({ length: Math.ceil(input.length / 16) }, (_, i) =>
      input.slice(i * 16, i * 16 + 16),
    );
    await assert.rejects(
      pipeline(Readable.from(chunks), new Parser(), async (tokens) => {
        for await (const token of tokens) void token;
      }),
    );
    await assert.rejects(pipeline(Readable.from(chunks), new Verifier()));
  }
});
