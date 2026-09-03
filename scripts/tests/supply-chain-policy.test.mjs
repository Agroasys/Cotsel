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
    'gh attestation verify',
    'node scripts/resolve-release-image-provenance.mjs',
    'producingWorkflowRunUri',
    'verificationWorkflowRunId',
    'imageReused',
    '- name: Attest image provenance',
    "  if: steps.kind.outputs.publish == 'true' && steps.build.outputs.digest != ''",
    '  uses: actions/attest@0123456789abcdef0123456789abcdef01234567',
    '- name: Attest image SBOM',
    "  if: steps.kind.outputs.publish == 'true'",
    '  uses: actions/attest@0123456789abcdef0123456789abcdef01234567',
    '- name: Preserve signed provenance bundle',
    "  if: steps.kind.outputs.publish == 'true' && steps.build.outputs.digest != ''",
    '  run: cp bundle evidence',
    '- name: Next step',
  ].join('\n');
  assert.equal(releaseWorkflowViolations(complete).length, 0);
  assert.ok(releaseWorkflowViolations(complete.replace('sbom: true', '')).length > 0);
  assert.match(
    releaseWorkflowViolations(`${complete}\nignore-unfixed: true`)[0],
    /must not bypass the gate/u,
  );
  assert.match(
    releaseWorkflowViolations(
      complete.replace(
        "if: steps.kind.outputs.publish == 'true' && steps.build.outputs.digest != ''",
        "if: steps.kind.outputs.publish == 'true'",
      ),
    ).join('\n'),
    /Attest image provenance must run only for a newly built image/u,
  );
  assert.match(
    releaseWorkflowViolations(
      complete.replace(
        "- name: Attest image SBOM\n  if: steps.kind.outputs.publish == 'true'",
        "- name: Attest image SBOM\n  if: steps.kind.outputs.publish == 'false'",
      ),
    ).join('\n'),
    /must attest its SBOM/u,
  );
});
