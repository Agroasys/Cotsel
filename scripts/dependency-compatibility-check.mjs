#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const virtualStore = path.resolve('node_modules/.pnpm');
const minimatchVersions = ['3.1.5', '5.1.9', '9.0.9', '10.2.5'];

function packagePath(name, version) {
  const prefix = `${name}@${version}`;
  const matches = fs
    .readdirSync(virtualStore)
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}_`));

  assert.equal(
    matches.length,
    1,
    `Expected one installed ${name}@${version}, found ${matches.length}`,
  );
  return path.join(virtualStore, matches[0], 'node_modules', name);
}

const braceTargets = new Set();
for (const version of minimatchVersions) {
  const minimatchPath = packagePath('minimatch', version);
  const bracePath = fs.realpathSync(path.join(path.dirname(minimatchPath), 'brace-expansion'));
  braceTargets.add(bracePath);

  const minimatchModule = require(minimatchPath);
  const minimatch =
    typeof minimatchModule === 'function' ? minimatchModule : minimatchModule.minimatch;
  assert.equal(typeof minimatch, 'function', `minimatch@${version} must expose a callable API`);
  assert.equal(minimatch('src/routes/trade.ts', 'src/**/*.ts'), true);
}

assert.equal(
  braceTargets.size,
  1,
  'All minimatch versions must resolve one patched brace-expansion',
);
const [bracePath] = braceTargets;
assert.match(bracePath, /brace-expansion@5\.0\.12_patch_hash=/);

const braceExpansion = require(bracePath);
assert.equal(
  typeof braceExpansion,
  'function',
  'Legacy CommonJS consumers require a callable export',
);
assert.equal(
  braceExpansion.expand,
  braceExpansion,
  'The named and callable APIs must use the same function',
);
assert.deepEqual(braceExpansion('file-{a,b}.txt'), ['file-a.txt', 'file-b.txt']);
assert.equal(braceExpansion('{1..200000}').length, braceExpansion.EXPANSION_MAX);

const lengthCapped = braceExpansion('{a,b}'.repeat(1500), { maxLength: 100 });
assert.ok(lengthCapped.reduce((total, value) => total + value.length, 0) <= 100);

const jaysonPath = packagePath('jayson', '4.3.0');
const streamJsonPath = fs.realpathSync(path.join(path.dirname(jaysonPath), 'stream-json'));
assert.match(
  streamJsonPath,
  /stream-json@1\.9\.1_patch_hash=/,
  'jayson must resolve the security-patched legacy stream-json release',
);

const jaysonUtils = require(path.join(jaysonPath, 'lib', 'utils.js'));
const nestedRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'health',
  params: { payload: Array.from({ length: 250 }, (_, index) => ({ index })) },
};
const parsedRequest = await new Promise((resolve, reject) => {
  jaysonUtils.parseStream(Readable.from([JSON.stringify(nestedRequest)]), {}, (error, request) => {
    if (error) reject(error);
    else resolve(request);
  });
});
assert.deepEqual(parsedRequest, nestedRequest);

const Pick = require(path.join(streamJsonPath, 'filters', 'Pick.js'));
await new Promise((resolve, reject) => {
  const depth = 50;
  const input = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
  const source = Readable.from([input]);
  const pipeline = source.pipe(Pick.withParser({ filter: 'missing', maxDepth: 10 }));
  source.on('error', reject);
  pipeline.on('data', () => {});
  pipeline.on('error', (error) => {
    if (error instanceof RangeError) resolve();
    else reject(error);
  });
  pipeline.on('end', () => reject(new Error('Expected an over-depth JSON error')));
});

console.log(
  `Dependency compatibility check passed: minimatch ${minimatchVersions.join(', ')} -> patched brace-expansion 5.0.12; jayson 4.3.0 -> security-patched stream-json 1.9.1`,
);
