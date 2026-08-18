#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, 'verify-plan-metadata.mjs');
const digest = 'a'.repeat(64);
const expectedEnvironment = {
  ...process.env,
  EXPECTED_ROOT: 'staging-platform',
  EXPECTED_REPOSITORY: 'Agroasys/Cotsel',
  EXPECTED_RUN_ID: '123456',
  EXPECTED_RUN_ATTEMPT: '1',
  EXPECTED_HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
  EXPECTED_ACTOR: 'plan-author',
};
const validMetadata = {
  action: 'plan',
  root: 'staging-platform',
  repository: 'Agroasys/Cotsel',
  'workflow-path': '.github/workflows/terraform.yml',
  'run-id': '123456',
  'run-attempt': '1',
  'head-sha': '0123456789abcdef0123456789abcdef01234567',
  ref: 'refs/heads/main',
  actor: 'plan-author',
  'plan-sha256': digest,
};

const cases = [
  { name: 'valid metadata', metadata: validMetadata, expected: 0 },
  { name: 'apply action', metadata: { ...validMetadata, action: 'apply' }, expected: 1 },
  { name: 'wrong root', metadata: { ...validMetadata, root: 'bootstrap' }, expected: 1 },
  {
    name: 'wrong workflow',
    metadata: { ...validMetadata, 'workflow-path': 'other.yml' },
    expected: 1,
  },
  { name: 'wrong commit', metadata: { ...validMetadata, 'head-sha': 'f'.repeat(40) }, expected: 1 },
  { name: 'wrong actor', metadata: { ...validMetadata, actor: 'other-person' }, expected: 1 },
  { name: 'wrong run attempt', metadata: { ...validMetadata, 'run-attempt': '2' }, expected: 1 },
  {
    name: 'invalid digest',
    metadata: { ...validMetadata, 'plan-sha256': 'not-a-digest' },
    expected: 1,
  },
];

let failures = 0;
for (const testCase of cases) {
  const result = spawnSync('node', [checker], {
    env: expectedEnvironment,
    input: JSON.stringify({ Metadata: testCase.metadata }),
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
  console.error(`\n${failures} plan metadata fixture(s) behaved unexpectedly.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} plan metadata fixtures behaved as expected.`);
