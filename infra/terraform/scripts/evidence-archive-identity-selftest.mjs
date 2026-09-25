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
const archiveWorkflow = readFileSync(
  join(here, '..', '..', '..', '.github', 'workflows', 'archive-base-sepolia-evidence.yml'),
  'utf8',
);

assert.match(terraform, /permissions_boundary\s+= local\.writer_boundary_arn/);
assert.match(terraform, /agroasys-cotsel-evidence-writer-boundary/);
assert.match(terraform, /depends_on = \[aws_iam_role\.writer\]/);
assert.match(terraform, /agroasys-cotsel-base-sepolia-evidence-reader/);
assert.match(terraform, /EvidenceReaderDecryption/);
assert.match(terraform, /cloud_watch_logs_role_arn\s+= local\.cloudtrail_role_arn/);
assert.match(terraform, /cloud_watch_logs_group_arn\s+=.*local\.audit_log_group/);

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

assert.match(archiveWorkflow, /action:[\s\S]*write-denial-test[\s\S]*verify-custody/);
assert.match(archiveWorkflow, /READER_ROLE_ARN:.*agroasys-cotsel-base-sepolia-evidence-reader/);
assert.match(archiveWorkflow, /verify-custody:[\s\S]*environment: base-sepolia-evidence-review/);
assert.match(archiveWorkflow, /The writer and independent reader must be different actors/);
assert.match(
  archiveWorkflow,
  /IFS=\$'\\t' read -r NAME PATH_ EVENT BRANCH CONCLUSION ACTOR SHA CREATED/,
);
assert.match(archiveWorkflow, /put-object-retention[\s\S]*bypass-governance-retention/);
assert.match(archiveWorkflow, /put-object-legal-hold/);
assert.match(archiveWorkflow, /CloudTrail did not deliver every required denial/);
assert.match(
  archiveWorkflow,
  /describe-metric-filters[\s\S]*DeniedArchiveMutation[\s\S]*DeniedArchiveKeyMutation/,
);
assert.match(archiveWorkflow, /filters are not bound to the exact archive bucket and KMS key/);
assert.match(archiveWorkflow, /SubscriptionsConfirmed/);

console.log('Evidence archive separates plan, apply, writer, reader, audit, and alert controls.');
