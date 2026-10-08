import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

export function verifyPackageIntegrity(bytes, packedIntegrity, publishedIntegrity) {
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(packedIntegrity, integrity, 'packed bytes differ from the pack record');
  assert.equal(publishedIntegrity, integrity, 'published package differs from the verified bytes');
  return { integrity, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function readPublishedIntegrity(version) {
  return JSON.parse(
    execFileSync(
      'npm',
      [
        'view',
        `@agroasys/sdk@${version}`,
        'dist.integrity',
        '--json',
        '--registry',
        'https://npm.pkg.github.com',
        '--fetch-retries=0',
        '--fetch-timeout=10000',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    ),
  );
}

export async function verifyPublishedIntegrity({
  bytes,
  packedIntegrity,
  version,
  readIntegrity = readPublishedIntegrity,
  wait = setTimeout,
}) {
  // Reject an invalid pack record before querying the registry.
  verifyPackageIntegrity(bytes, packedIntegrity, packedIntegrity);
  const delays = [1000, 2000, 4000, 8000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let published;
    try {
      published = await readIntegrity(version);
      assert.match(published, /^sha512-[A-Za-z0-9+/]{86}==$/u, 'registry integrity is unavailable');
    } catch {
      if (attempt === delays.length) {
        throw new Error(
          'Registry integrity unavailable after five attempts; release is unverified',
        );
      }
      console.warn(`Registry integrity unavailable; retry ${attempt + 1}/${delays.length}.`);
      await wait(delays[attempt]);
      continue;
    }
    // A valid but different digest is an integrity failure, never a retryable read failure.
    return verifyPackageIntegrity(bytes, packedIntegrity, published);
  }
}

async function run() {
  const bytes = fs.readFileSync(process.env.PACKAGE_FILE);
  const identity = await verifyPublishedIntegrity({
    bytes,
    packedIntegrity: process.env.PACKAGE_INTEGRITY,
    version: process.env.SDK_VERSION,
  });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await run();
