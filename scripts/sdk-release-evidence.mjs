import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyPackageIntegrity(bytes, packedIntegrity, publishedIntegrity) {
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(packedIntegrity, integrity, 'packed bytes differ from the pack record');
  assert.equal(publishedIntegrity, integrity, 'published package differs from the verified bytes');
  return { integrity, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function run() {
  const bytes = fs.readFileSync(process.env.PACKAGE_FILE);
  const published = JSON.parse(
    execFileSync(
      'npm',
      [
        'view',
        `@agroasys/sdk@${process.env.SDK_VERSION}`,
        'dist.integrity',
        '--json',
        '--registry',
        'https://npm.pkg.github.com',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  const identity = verifyPackageIntegrity(bytes, process.env.PACKAGE_INTEGRITY, published);
  const sbom = 'sdk/sbom-build-workspace.spdx.json';
  const evidence = {
    package: '@agroasys/sdk',
    version: process.env.SDK_VERSION,
    sourceCommit: process.env.GITHUB_SHA,
    workflowRunId: process.env.GITHUB_RUN_ID,
    artifact: { path: process.env.PACKAGE_FILE, ...identity },
    sbom: {
      path: sbom,
      scope: 'build-workspace',
      sha256: createHash('sha256').update(fs.readFileSync(sbom)).digest('hex'),
    },
    published: true,
    attestationVerified: true,
  };
  fs.writeFileSync('sdk/release-sdk.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('Published SDK matches the attested package bytes.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
