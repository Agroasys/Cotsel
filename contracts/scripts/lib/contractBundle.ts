// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import type { Artifact, BuildInfo } from 'hardhat/types';
import demoContract from '../../../integration/base-sepolia-demo-contract.json';
import deploymentReport from '../../reports/deploy/base-sepolia/demo-deployment.json';
import preparationReport from '../../reports/deploy/base-sepolia/demo-preparation.json';
import { normalizeRuntimeBytecode, sha256Hex } from './contractBytecode';

const escrowName = 'AgroasysEscrow';
const escrowSource = 'src/AgroasysEscrow.sol';
export const qualifiedEscrowName = `${escrowSource}:${escrowName}`;

export function createContractBundle(
  artifact: Artifact,
  buildInfo: BuildInfo,
  source: { commit: string; lockfileSha256: string },
) {
  const deployment = demoContract;
  const report = deploymentReport;
  assert.equal(preparationReport.commitSha, deployment.sourceCommit);
  assert.equal(report.commitSha, deployment.finalizerCommit);
  assert.equal(preparationReport.network.chainId, deployment.chainId);
  assert.equal(preparationReport.transaction.expectedContractAddress, deployment.address);
  assert.equal(report.network.chainId, deployment.chainId);
  assert.equal(report.contract.address, deployment.address);
  assert.equal(report.contract.deploymentBlock, deployment.deploymentBlock);
  assert.equal(report.contract.deploymentTxHash, deployment.deploymentTransactionHash);
  assert.equal(report.contract.deploymentReceiptStatus, 1);
  assert.equal(report.artifact.runtimeBytecodeMatches, true);
  assert.equal(report.artifact.compilerInputSha256, deployment.artifact.compilerInputSha256);

  assert.equal(artifact.contractName, escrowName);
  assert.equal(artifact.sourceName, escrowSource);
  const compiled = buildInfo.output.contracts[escrowSource]?.[escrowName];
  assert.ok(compiled, `Missing compiler output for ${qualifiedEscrowName}`);
  assert.deepEqual(artifact.abi, compiled.abi, 'Artifact ABI differs from compiler output');
  assert.equal(artifact.bytecode, `0x${compiled.evm.bytecode.object}`);
  assert.equal(artifact.deployedBytecode, `0x${compiled.evm.deployedBytecode.object}`);
  assert.equal(buildInfo.solcLongVersion, deployment.artifact.compilerVersion);
  const abiSha256 = sha256Hex(JSON.stringify(artifact.abi));
  const creationBytecodeSha256 = sha256Hex(artifact.bytecode);
  const immutableReferences = compiled.evm.deployedBytecode.immutableReferences ?? {};
  const normalizedRuntimeBytecodeSha256 = sha256Hex(
    normalizeRuntimeBytecode(artifact.deployedBytecode, immutableReferences),
  );

  assert.equal(abiSha256, deployment.artifact.abiSha256, 'Escrow ABI differs from demo evidence');
  assert.equal(abiSha256, report.artifact.abiSha256, 'Escrow ABI differs from deployment report');
  assert.equal(
    creationBytecodeSha256,
    deployment.artifact.creationBytecodeSha256,
    'Escrow creation bytecode differs from demo evidence',
  );
  assert.equal(creationBytecodeSha256, report.artifact.bytecodeSha256);
  assert.equal(
    normalizedRuntimeBytecodeSha256,
    deployment.artifact.normalizedRuntimeBytecodeSha256,
    'Escrow normalized runtime differs from demo evidence',
  );
  assert.equal(normalizedRuntimeBytecodeSha256, report.artifact.normalizedRuntimeBytecodeSha256);

  const compilerInput = JSON.stringify(buildInfo.input);
  return {
    compilerInput,
    manifest: {
      schemaVersion: 'cotsel.contract-bundle.v1',
      contract: qualifiedEscrowName,
      source,
      compiler: {
        version: buildInfo.solcVersion,
        longVersion: buildInfo.solcLongVersion,
        settings: buildInfo.input.settings,
        inputSha256: sha256Hex(compilerInput),
        sourceSha256: Object.fromEntries(
          Object.entries(buildInfo.input.sources).map(([name, input]) => [
            name,
            sha256Hex(input.content),
          ]),
        ),
      },
      artifact: {
        abiSha256,
        creationBytecodeSha256,
        normalizedRuntimeBytecodeSha256,
        immutableReferences,
      },
      deploymentParity: {
        basis: 'retained-demo-deployment-evidence',
        status: deployment.status,
        custodyAttestation: deployment.custodyAttestation,
        deployedSourceCommit: deployment.sourceCommit,
        finalizerCommit: deployment.finalizerCommit,
        deployedCompilerInputSha256: deployment.artifact.compilerInputSha256,
        preparationEvidence: deployment.preparationEvidence,
        deploymentEvidence: deployment.deploymentEvidence,
        chainId: deployment.chainId,
        address: deployment.address,
        transactionHash: deployment.deploymentTransactionHash,
        block: deployment.deploymentBlock,
        runtimeCodehash: deployment.runtimeCodehash,
      },
      sbom: {
        required: false,
        rationale: 'The escrow artifact records compiler inputs, source hashes, ABI, and bytecode.',
      },
    },
  };
}
