import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeViolations,
  dockerfileViolations,
  releaseWorkflowViolations,
  workflowViolations,
} from '../check-supply-chain-policy.mjs';

test('external actions require immutable commit SHAs', () => {
  assert.equal(
    workflowViolations(
      'workflow.yml',
      'uses: actions/checkout@0123456789abcdef0123456789abcdef01234567',
    ).length,
    0,
  );
  assert.match(
    workflowViolations('workflow.yml', 'uses: actions/checkout@v4')[0],
    /40-character commit SHA/u,
  );
});

test('workflow Node versions must match the supported patch release', () => {
  assert.equal(workflowViolations('workflow.yml', "node-version: '22.23.2'").length, 0);
  assert.match(workflowViolations('workflow.yml', "node-version: '22'")[0], /22\.23\.2/u);
});

test('Docker and Compose images require sha256 digests', () => {
  const digest = 'a'.repeat(64);
  assert.equal(
    dockerfileViolations('Dockerfile', `FROM node:22-alpine@sha256:${digest}`).length,
    0,
  );
  assert.match(dockerfileViolations('Dockerfile', 'FROM node:22-alpine')[0], /digest-pinned/u);
  assert.equal(
    composeViolations('compose.yml', `  image: redis:7-alpine@sha256:${digest}`).length,
    0,
  );
  assert.match(composeViolations('compose.yml', '  image: redis:7-alpine')[0], /digest-pinned/u);
});

test('release workflow requires signed provenance and SBOM controls', () => {
  const complete = [
    'artifact-metadata: write',
    'attestations: write',
    'provenance: mode=max',
    'sbom: true',
    'format: spdx-json',
    'severity: HIGH,CRITICAL',
    "exit-code: '1'",
    'uses: actions/attest@0123456789abcdef0123456789abcdef01234567',
    'gh attestation verify',
  ].join('\n');
  assert.equal(releaseWorkflowViolations(complete).length, 0);
  assert.ok(releaseWorkflowViolations(complete.replace('sbom: true', '')).length > 0);
  assert.match(
    releaseWorkflowViolations(`${complete}\nignore-unfixed: true`)[0],
    /must not bypass the gate/u,
  );
});
