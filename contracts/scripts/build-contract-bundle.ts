// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { artifacts } from 'hardhat';
import { createContractBundle, qualifiedEscrowName } from './lib/contractBundle';
import { sha256Hex } from './lib/contractBytecode';
import { getDeploymentSourceIdentity } from './lib/deploymentSourceIdentity';

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(__dirname, '../..');
  const { commitSha } = getDeploymentSourceIdentity(repositoryRoot);
  const output = process.env.CONTRACT_BUNDLE_OUT_DIR;
  assert.ok(output, 'CONTRACT_BUNDLE_OUT_DIR must name a new directory');

  const artifact = await artifacts.readArtifact(qualifiedEscrowName);
  const buildInfo = await artifacts.getBuildInfo(qualifiedEscrowName);
  assert.ok(buildInfo, `Missing build information for ${qualifiedEscrowName}`);
  const { compilerInput, manifest } = createContractBundle(artifact, buildInfo, {
    commit: commitSha,
    lockfileSha256: sha256Hex(fs.readFileSync(path.join(repositoryRoot, 'pnpm-lock.yaml'))),
  });

  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(
    path.join(output, 'AgroasysEscrow.json'),
    JSON.stringify(artifact, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(output, 'compiler-input.json'), compilerInput);
  fs.writeFileSync(
    path.join(output, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(
    `Compiled escrow matches retained Base Sepolia demo bytecode at source ${commitSha}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
