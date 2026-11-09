import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { releaseCandidateInventory } from '../lib/release-candidate-inventory.mjs';
import { verifyImageSbomBinding } from '../verify-image-sbom-binding.mjs';

const workflowPath = new URL('../../.github/workflows/release-images.yml', import.meta.url);
const downloadConfig = fileURLToPath(new URL('../../.github/sbom-download/', import.meta.url));
const execute = promisify(execFile);

async function probeInstallerDownload(failures) {
  const directory = await mkdtemp(join(tmpdir(), 'cotsel-sbom-retry-'));
  const artifact = join(directory, 'artifact');
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.statusCode = requests <= failures ? 504 : 200;
    res.end(res.statusCode === 200 ? 'release bytes' : 'gateway timeout');
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    // Match the pinned Syft installer's curl invocation and final-status check.
    const { stdout } = await execute(
      'curl',
      [
        '--noproxy',
        '127.0.0.1',
        '-w',
        '%{http_code}',
        '-sL',
        '-o',
        artifact,
        `http://127.0.0.1:${port}`,
      ],
      { env: { ...process.env, CURL_HOME: downloadConfig }, timeout: 20000 },
    );
    return { status: stdout.trim(), requests, bytes: await readFile(artifact, 'utf8') };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('SBOM installer retries transient 504 responses without changing downloaded bytes', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /CURL_HOME: \$\{\{ github\.workspace \}\}\/\.github\/sbom-download/u);
  assert.deepEqual(await probeInstallerDownload(2), {
    status: '200',
    requests: 3,
    bytes: 'release bytes',
  });
});

test('SBOM installer stops after three retries and preserves a persistent failure status', async () => {
  assert.deepEqual(await probeInstallerDownload(Infinity), {
    status: '504',
    requests: 4,
    bytes: 'gateway timeout',
  });
});

test('image jobs reuse only the pinned Syft tool prepared for the same run and source', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const producer = workflow.slice(
    workflow.indexOf('  registry-ready:'),
    workflow.indexOf('\n  build:'),
  );
  const consumers = workflow.slice(workflow.indexOf('\n  build:'));
  assert.match(
    producer,
    /anchore\/sbom-action\/download-syft@66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c/u,
  );
  assert.match(producer, /syft-version: v1\.54\.1/u);
  assert.match(producer, /actions\/cache\/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/u);
  assert.match(consumers, /needs: registry-ready/u);
  assert.match(consumers, /actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/u);
  const keys = [...workflow.matchAll(/key: (syft-v1\.54\.1[^\n]+)/gu)].map((match) => match[1]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /\$\{\{ github\.run_id \}\}-\$\{\{ github\.sha \}\}$/u);
  assert.match(consumers, /fail-on-cache-miss: true/u);
  assert.doesNotMatch(workflow, /restore-keys:/u);
});

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
  assert.match(workflow, /sigstore\/cosign-installer@756fe2d284c7292c4e9b62c8a28f1e5629c59532/);
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
