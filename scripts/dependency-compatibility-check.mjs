#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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
assert.match(bracePath, /brace-expansion@5\.0\.9_patch_hash=/);

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

console.log(
  `Dependency compatibility check passed: minimatch ${minimatchVersions.join(', ')} -> patched brace-expansion 5.0.9`,
);
