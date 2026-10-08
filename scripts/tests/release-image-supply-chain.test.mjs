import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { releaseCandidateInventory } from '../lib/release-candidate-inventory.mjs';
import { verifyImageSbomBinding } from '../verify-image-sbom-binding.mjs';

const workflowPath = new URL('../../.github/workflows/release-images.yml', import.meta.url);

const sbomBinding = () => {
  const sbom = { spdxVersion: 'SPDX-2.3', packages: [{ name: 'image-runtime', versionInfo: '1' }] };
  const sourceCommit = 'a'.repeat(40);
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  return {
    sbom,
    sourceCommit,
    imageDigest,
    verificationResults: [
      {
        verificationResult: {
          signature: {
            certificate: {
              subjectAlternativeName:
                'https://github.com/Agroasys/Cotsel/.github/workflows/release-images.yml@refs/heads/main',
              issuer: 'https://token.actions.githubusercontent.com',
              sourceRepositoryURI: 'https://github.com/Agroasys/Cotsel',
              sourceRepositoryDigest: sourceCommit,
              sourceRepositoryRef: 'refs/heads/main',
              runnerEnvironment: 'github-hosted',
            },
          },
          statement: {
            predicateType: 'https://spdx.dev/Document/v2.3',
            subject: [{ digest: { sha256: imageDigest.slice(7) } }],
            predicate: structuredClone(sbom),
          },
        },
      },
    ],
  };
};

test('recorded image SBOM must equal the verified signed document', () => {
  const binding = sbomBinding();
  assert.doesNotThrow(() => verifyImageSbomBinding(binding));
  binding.sbom.packages[0].versionInfo = 'unsigned-other-report';
  assert.throws(() => verifyImageSbomBinding(binding), /must equal/u);
});

test('SBOM binding rejects wrong source, digest, predicate, identity, and unverified records', () => {
  for (const change of [
    (b) => {
      b.sourceCommit = 'c'.repeat(40);
    },
    (b) => {
      b.imageDigest = `sha256:${'c'.repeat(64)}`;
    },
    (b) => {
      b.verificationResults[0].verificationResult.statement.predicateType = 'other';
    },
    (b) => {
      b.verificationResults[0].verificationResult.signature.certificate.subjectAlternativeName =
        'other';
    },
    (b) => {
      b.verificationResults[0].verificationResult.signature.certificate.issuer = 'other';
    },
    (b) => {
      b.verificationResults[0].verificationResult.signature.certificate.sourceRepositoryRef =
        'refs/heads/feature';
    },
    (b) => {
      b.verificationResults[0].verificationResult.signature.certificate.runnerEnvironment =
        'self-hosted';
    },
    (b) => {
      delete b.verificationResults[0].verificationResult;
    },
    (b) => {
      b.verificationResults = [];
    },
  ]) {
    const binding = sbomBinding();
    change(binding);
    assert.throws(() => verifyImageSbomBinding(binding));
  }
});

test('published image metadata records the SBOM passed to the attester and binding check', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /sbom-path: sbom-image-\$\{\{ matrix\.service \}\}\.spdx\.json/u);
  assert.match(workflow, /const sbomPath = `sbom-image-\$\{process\.env\.SERVICE\}\.spdx\.json`/u);
  assert.match(workflow, /node scripts\/verify-image-sbom-binding.mjs/u);
  assert.doesNotMatch(workflow, /sbom-\$\{\{ matrix\.service \}\}\.spdx\.json/u);
  assert.equal((workflow.match(/uses: aquasecurity\/trivy-action@/gu) ?? []).length, 1);
  assert.match(workflow, /output: scan-image-\$\{\{ matrix\.service \}\}\.json/u);
});

test('published images require provenance, an SBOM, and verified keyless signatures', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /anchore\/sbom-action@66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c/);
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

test('new image provenance is recorded before fallible signature checks', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const attest = workflow.indexOf('- name: Attest image provenance');
  const preserve = workflow.indexOf('- name: Preserve signed provenance bundle');
  const sign = workflow.indexOf('- name: Sign and verify the published image digest');

  assert.notEqual(attest, -1);
  assert.notEqual(preserve, -1);
  assert.notEqual(sign, -1);
  assert.ok(attest < preserve, 'provenance must be attested before it is preserved');
  assert.ok(preserve < sign, 'provenance must exist before signature checks can fail');
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

test('supersedes candidate images without cancelling mainline releases', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(
    workflow,
    /group: release-images-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.sha \}\}/,
  );
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('builds every Cotsel release image through the same supply-chain workflow', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const images = releaseCandidateInventory().artifacts.filter(
    (artifact) =>
      artifact.kind === 'container-image' && artifact.sourceRepository === 'Agroasys/Cotsel',
  );
  for (const image of images) {
    assert.match(workflow, new RegExp(`service: ${image.name}`, 'u'));
    assert.match(workflow, new RegExp(`repository: ${image.repository}`, 'u'));
    assert.match(workflow, new RegExp(`dockerfile: ${image.dockerfile}`, 'u'));
  }
});
