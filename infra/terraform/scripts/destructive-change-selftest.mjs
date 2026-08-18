#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, 'check-destructive-changes.mjs');
const cases = [
  { name: 'allowed-create.json', expected: 0 },
  { name: 'blocked-secret-delete.json', expected: 1 },
  { name: 'blocked-registry-replace.json', expected: 1 },
];

let failures = 0;
for (const testCase of cases) {
  const result = spawnSync('node', [checker], {
    input: readFileSync(join(here, 'fixtures', testCase.name)),
    encoding: 'utf8',
  });
  const actual = result.status ?? 1;
  const passed = actual === testCase.expected;
  if (!passed) failures += 1;
  console.log(
    `  ${passed ? 'pass' : 'FAIL'}  ${testCase.name}  expected exit ${testCase.expected}, got ${actual}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} destructive-change fixture(s) behaved unexpectedly.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} destructive-change fixtures behaved as expected.`);
