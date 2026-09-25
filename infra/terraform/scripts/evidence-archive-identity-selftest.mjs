#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const terraform = readFileSync(
  join(here, '..', 'base-sepolia-evidence-archive', 'archive.tf'),
  'utf8',
);
const workflow = readFileSync(
  join(here, '..', '..', '..', '.github', 'workflows', 'terraform.yml'),
  'utf8',
);

assert.match(terraform, /permissions_boundary\s+= local\.writer_boundary_arn/);
assert.match(terraform, /agroasys-cotsel-evidence-writer-boundary/);
assert.match(terraform, /depends_on = \[aws_iam_role\.writer\]/);

assert.match(workflow, /EVIDENCE_PLAN_ROLE_ARN:.*agroasys-cotsel-evidence-archive-plan/);
assert.match(workflow, /EVIDENCE_APPLY_ROLE_ARN:.*agroasys-cotsel-evidence-archive-apply/);
assert.match(
  workflow,
  /github\.event\.inputs\.root == 'base-sepolia-evidence-archive'[\s\S]*env\.EVIDENCE_PLAN_ROLE_ARN/,
);
assert.match(
  workflow,
  /github\.event\.inputs\.root == 'base-sepolia-evidence-archive'[\s\S]*env\.EVIDENCE_APPLY_ROLE_ARN/,
);
assert.match(
  workflow,
  /environment: \$\{\{ github\.event\.inputs\.root == 'base-sepolia-evidence-archive' && 'base-sepolia-evidence' \|\| 'staging' \}\}/,
);

console.log('Evidence archive uses dedicated plan, apply, and writer boundaries.');
