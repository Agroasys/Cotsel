import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/release-images.yml', import.meta.url);

test('published images require provenance, an SBOM, and verified keyless signatures', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /anchore\/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26/);
  assert.match(workflow, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
  assert.match(workflow, /cosign sign --yes "\$IMAGE_REFERENCE"/);
  assert.match(workflow, /cosign verify \\/);
  assert.match(workflow, /sbom-image-\$\{\{ matrix\.service \}\}\.spdx\.json/);
  assert.match(workflow, /if \(!Array\.isArray\(payload\) \|\| payload\.length === 0\)/);
  assert.match(workflow, /echo "verified=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /signatureVerified: published \? signatureVerified : null/);
});

test('reused digests do not claim provenance from the current workflow run', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /echo "provenance_generated=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /echo "reused_existing_digest=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(
    workflow,
    /buildProvenance: provenanceGenerated\s+\? \{ mode: "max", producingWorkflowRunId:/,
  );
  assert.match(workflow, /reusedExistingDigest,/);
  assert.doesNotMatch(workflow, /buildProvenance: published \? "mode=max" : null/);
});

test('pull request image builds remain credential-free', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(
    workflow,
    /if: steps\.kind\.outputs\.publish == 'true'\n\s+uses: aws-actions\/configure-aws-credentials@/,
  );
  assert.match(
    workflow,
    /if: steps\.kind\.outputs\.publish != 'true'\n\s+uses: docker\/build-push-action@/,
  );
  assert.doesNotMatch(workflow, /pull_request_target:/);
});
