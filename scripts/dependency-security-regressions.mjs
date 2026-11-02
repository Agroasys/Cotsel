// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { installedPackagePath } from './installed-dependency-paths.mjs';

const require = createRequire(import.meta.url);
const ellipticDirectory = installedPackagePath('elliptic', '6.6.1');
assert.match(ellipticDirectory, /_patch_hash=/);
const { ec: EC } = require(ellipticDirectory);
const p521 = new EC('p521');
const privateKey = Buffer.alloc(66);
privateKey[65] = 1;
// Independent noble-curves P-521 vector: RFC 6979 nonce begins with a zero octet.
const message = Buffer.from(
  '71435d57b8a42ca5b349f4a28ade220e6724bdaaff0f2154e28b25a46ff31ebdc006bd3bf27ffa4be7090987c10dcc6c21badb1218f57f94921f5b7077ce0027',
  'hex',
);
const signature = p521.sign(message, privateKey);
assert.equal(
  signature.r.toString(16),
  '125ed146a973408d20a678c3fe4a2b07ca22ca8c624914c15f59dfc6a4a6f3922c2bb994009d59bf9b87d69316ccc167a04dfecdb634426aeb8381c5c65229e2739',
);
assert.equal(
  signature.s.toString(16),
  '24e5b5c3c68bec0f1d8b0a8b7a9b198efb82880ffd10423fe4f63acb75124d6de29cbed36567547c7736b002959b1ebe96d8e0a1a3b05da0067393cd0ae2436860',
);
assert.equal(p521.verify(message, signature, p521.keyFromPrivate(privateKey)), true);
const ethersRequire = createRequire(require.resolve('ethers'));
const { p521: independentP521 } = ethersRequire('@noble/curves/p521');
assert.equal(
  independentP521.sign(message, privateKey, { lowS: false, prehash: false }).r.toString(16),
  signature.r.toString(16),
);
// The byte-aligned curve used by Ethereum must retain its deterministic signatures.
const secp = new EC('secp256k1');
const { secp256k1 } = ethersRequire('@noble/curves/secp256k1');
const ethereumKey = privateKey.subarray(34);
const digest = message.subarray(0, 32);
const ethereumSignature = secp.sign(digest, ethereumKey, { canonical: true });
const independentSignature = secp256k1.sign(digest, ethereumKey, { lowS: true, prehash: false });
assert.equal(ethereumSignature.r.toString(16), independentSignature.r.toString(16));
assert.equal(ethereumSignature.s.toString(16), independentSignature.s.toString(16));
const helperRequire = createRequire(
  fs.realpathSync('contracts/node_modules/@nomicfoundation/hardhat-network-helpers/package.json'),
);
const addressUtil = helperRequire('ethereumjs-util');
assert.match(helperRequire.resolve('ethereumjs-util'), /@ethereumjs[+/]util@9\.1\.0/);
for (const value of [
  '0x0000000000000000000000000000000000000000',
  '0x52908400098527886E0F7030069857D2E4169EE7',
]) {
  assert.equal(addressUtil.isValidAddress(value), true);
  assert.equal(addressUtil.isValidChecksumAddress(value), true);
}
assert.equal(addressUtil.isValidAddress('0x123'), false);
assert.equal(
  addressUtil.isValidChecksumAddress('0x52908400098527886E0F7030069857D2E4169Ee7'),
  false,
);

const mergePath = installedPackagePath('deepmerge', '4.3.1');
assert.match(mergePath, /_patch_hash=/);
const merge = require(mergePath);
const poison = JSON.parse('{"__proto__":{"poisoned":true}}');
for (const result of [
  merge(Object.create(null), poison),
  merge(poison, {}),
  merge({ nested: Object.create(null) }, { nested: poison }).nested,
]) {
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.poisoned, undefined);
}
assert.deepEqual(
  merge({ values: [1], nested: { a: true } }, { values: [2], nested: { b: true } }),
  { values: [1, 2], nested: { a: true, b: true } },
);

// The advisory's optimizationLevel=2 preprocessor was introduced after the legacy 3/5 lines.
for (const version of ['3.1.5', '5.1.9']) {
  const matcher = require(installedPackagePath('minimatch', version));
  assert.equal(typeof matcher.Minimatch.prototype.firstPhasePreProcess, 'undefined');
  assert.equal(matcher('src/routes/trade.ts', 'src/**/*.ts', { optimizationLevel: 2 }), true);
}
for (const version of ['9.0.9', '10.2.5', '10.2.6']) {
  const directory = installedPackagePath('minimatch', version);
  assert.match(directory, /_patch_hash=/);
  for (const matcher of [
    require(directory),
    await import(pathToFileURL(path.join(directory, 'dist/esm/index.js')).href),
  ]) {
    const match = new matcher.Minimatch('src/**/*.ts', { optimizationLevel: 2, braceExpandMax: 4 });
    const amplified = match.firstPhasePreProcess([
      ['**', '..', 'a', 'b', '**', '..', 'c', 'd', '**', '..', 'e', 'f'],
    ]);
    assert.ok(amplified.length <= 4, `minimatch ${version} must cap generated patterns`);
    const many = Array.from({ length: 1001 }, (_, index) => [String(index)]);
    match.partsMatch = () => {
      throw new Error('Unexpected quadratic preprocessing');
    };
    assert.equal(match.secondPhasePreProcess(many), many);
    assert.equal(match.match('src/routes/trade.ts'), true);
  }
}

const streamDirectory = installedPackagePath('stream-json', '1.9.1');
for (const entry of ['jsonc/parser.js', 'jsonc/verifier.js']) {
  assert.equal(
    fs.existsSync(path.join(streamDirectory, entry)),
    false,
    'Legacy strict JSON must not expose the affected JSONC feature',
  );
}
const Parser = require(path.join(streamDirectory, 'Parser.js'));
const sink = () =>
  new Writable({
    objectMode: true,
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
await pipeline(Readable.from(['{"ok":true}']), new Parser(), sink());
await assert.rejects(
  pipeline(Readable.from(['/*', 'a'.repeat(1024), '*/1']), new Parser(), sink()),
);

// A real aborted filesystem walk must not continue reading directories in the background.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-glob-abort-'));
try {
  for (let index = 0; index < 20; index++)
    fs.mkdirSync(path.join(temporary, String(index), 'nested'), { recursive: true });
  for (const version of ['10.5.0', '13.0.6']) {
    const directory = installedPackagePath('glob', version);
    assert.match(directory, /_patch_hash=/);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(
      metadata.main.includes('.min.'),
      false,
      'Public entry must not embed unpatched dependency bundles',
    );
    for (const glob of [
      require(directory),
      await import(pathToFileURL(path.join(directory, metadata.exports['.'].import.default)).href),
    ]) {
      for (const streaming of [false, true]) {
        const controller = new AbortController();
        let reads = 0;
        const probeFs = {
          ...fs,
          readdir(...args) {
            const callback = args.pop();
            reads++;
            fs.readdir(...args, (error, entries) => {
              controller.abort(new Error('bounded-walk'));
              callback(error, entries);
            });
          },
        };
        const options = { cwd: temporary, signal: controller.signal, fs: probeFs };
        const walk = streaming
          ? (async () => {
              for await (const entry of glob.globStream('**/*', options)) void entry;
            })()
          : glob.glob('**/*', options);
        await assert.rejects(walk, /bounded-walk/);
        await setTimeout(20);
        assert.equal(
          reads,
          1,
          `glob ${version} must stop after abort (${streaming ? 'stream' : 'promise'})`,
        );
      }
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log(
  'Verified security regressions: elliptic RFC 6979 nonce width; preserved helper address validation; deepmerge prototype safety; minimatch amplification cap; absent legacy JSONC; glob abort stops filesystem work.',
);
