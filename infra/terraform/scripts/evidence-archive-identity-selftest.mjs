#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

// These event names come from the real archive writer drill. API operation
// names differ from the CloudTrail names for retention and legal hold.
const matcher = archiveWorkflow.match(
  /if jq -e --arg role "\$WRITER_ROLE_ARN"[\s\S]*?'([\s\S]*?)' "\$EVENTS_FILE"/,
);
assert.ok(matcher, 'The independent reader audit matcher must be exercised.');
const role = 'arn:aws:iam::123456789012:role/archive-writer';
const bucket = 'archive-test-bucket';
const key = 'base-sepolia/staging/candidates/test/archive-control/object.json';
const version = 'test-object-version';
const denials = [
  'GetObject',
  'DeleteObject',
  'PutObjectLockRetention',
  'PutObjectLockLegalHold',
].map((eventName) => ({
  eventName,
  errorCode: 'AccessDenied',
  userIdentity: { sessionContext: { sessionIssuer: { arn: role } } },
  requestParameters: { bucketName: bucket, key, versionId: version },
}));
function matches(records) {
  const result = spawnSync(
    'jq',
    [
      '-e',
      '--arg',
      'role',
      role,
      '--arg',
      'bucket',
      bucket,
      '--arg',
      'key',
      key,
      '--arg',
      'version',
      version,
      matcher[1],
    ],
    {
      input: JSON.stringify({
        events: records.map((record) => ({ message: JSON.stringify(record) })),
      }),
      encoding: 'utf8',
    },
  );
  assert.ok([0, 1].includes(result.status), result.stderr || 'jq failed to execute');
  return result.status === 0;
}
assert.equal(matches(denials), true, 'Real CloudTrail denial names must pass.');
assert.equal(matches(denials.slice(0, 3)), false, 'A missing denial must fail.');
assert.equal(
  matches(
    denials.map((record, index) =>
      index === 2
        ? {
            ...record,
            requestParameters: { ...record.requestParameters, versionId: 'another-version' },
          }
        : record,
    ),
  ),
  false,
  'Denials across different object versions must not be combined.',
);
for (const field of ['bucketName', 'key', 'versionId']) {
  const wrong = denials.map((record) => ({
    ...record,
    requestParameters: { ...record.requestParameters, [field]: 'another-object' },
  }));
  assert.equal(matches(wrong), false, `Denials for another ${field} must fail.`);
}
assert.equal(
  matches(
    denials.map((record) => ({
      ...record,
      userIdentity: { sessionContext: { sessionIssuer: { arn: 'another-role' } } },
    })),
  ),
  false,
  'Denials from another role must fail.',
);
assert.equal(
  matches(denials.map((record) => ({ ...record, errorCode: 'SomeOtherFailure' }))),
  false,
  'Other failures must not prove a permission denial.',
);

console.log('Evidence archive separates plan, apply, writer, reader, audit, and alert controls.');
