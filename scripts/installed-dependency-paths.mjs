// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Resolve the active dependency graph, never an unused copy left in pnpm's virtual store.
const graph = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--depth', 'Infinity', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const installed = new Map();
function visit(node) {
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, dependency] of Object.entries(node[kind] ?? {})) {
      // pnpm includes optional bindings for other operating systems in its graph.
      if (dependency.path && !fs.existsSync(dependency.path)) continue;
      if (dependency.path) {
        const key = `${name}@${dependency.version}`;
        if (!installed.has(key)) installed.set(key, new Set());
        installed.get(key).add(fs.realpathSync(dependency.path));
      }
      visit(dependency);
    }
  }
}
graph.forEach(visit);
export function installedPackagePath(name, version) {
  const matches = [...(installed.get(`${name}@${version}`) ?? [])];
  assert.equal(
    matches.length,
    1,
    `Expected one active ${name}@${version}, found ${matches.length}`,
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(matches[0], 'package.json'), 'utf8'));
  assert.equal(metadata.version, version);
  return matches[0];
}
export function hasInstalledPackage(name) {
  return [...installed.keys()].some((key) => key.startsWith(`${name}@`));
}
