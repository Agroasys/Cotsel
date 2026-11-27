// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { artifacts } from 'hardhat';
import demo from '../../../integration/base-sepolia-demo-contract.json';
import { createContractBundle, qualifiedEscrowName } from '../lib/contractBundle';
import { normalizeRuntimeBytecode, sha256Hex } from '../lib/contractBytecode';

const source = { commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64) };

async function loadProductionEscrow() {
  const artifact = await artifacts.readArtifact(qualifiedEscrowName);
  const buildInfo = await artifacts.getBuildInfo(qualifiedEscrowName);
  assert.ok(buildInfo);
  const compiled = buildInfo.output.contracts[artifact.sourceName][artifact.contractName];
  return { artifact, buildInfo, compiled };
}

function changeFirstByte(bytecode: string): string {
  return (bytecode.startsWith('00') ? '01' : '00') + bytecode.slice(2);
}

describe('contract release bundle', function () {
  it('binds the current compiler input to production escrow parity with the retained deployment', async function () {
    const { artifact, buildInfo } = await loadProductionEscrow();
    const { compilerInput, manifest } = createContractBundle(artifact, buildInfo, source);

    assert.equal(compilerInput, JSON.stringify(buildInfo.input));
    assert.deepEqual(manifest.source, source);
    assert.equal(manifest.compiler.inputSha256, sha256Hex(compilerInput));
    assert.equal(manifest.artifact.abiSha256, demo.artifact.abiSha256);
    assert.equal(manifest.artifact.creationBytecodeSha256, demo.artifact.creationBytecodeSha256);
    assert.equal(
      manifest.artifact.normalizedRuntimeBytecodeSha256,
      demo.artifact.normalizedRuntimeBytecodeSha256,
    );
    assert.equal(manifest.deploymentParity.deployedSourceCommit, demo.sourceCommit);
    assert.equal(manifest.deploymentParity.finalizerCommit, demo.finalizerCommit);
    assert.equal(
      manifest.deploymentParity.deployedCompilerInputSha256,
      demo.artifact.compilerInputSha256,
    );
    assert.equal(manifest.deploymentParity.custodyAttestation, 'unattested');
    assert.equal(manifest.sbom.required, false);
  });

  it('rejects changed compiler ABI even when the artifact matches the compiler output', async function () {
    const { artifact, buildInfo, compiled } = await loadProductionEscrow();
    artifact.abi = artifact.abi.slice(1);
    compiled.abi = artifact.abi;
    assert.throws(() => createContractBundle(artifact, buildInfo, source), /ABI differs/u);
  });

  it('rejects changed creation bytecode even when the artifact matches the compiler output', async function () {
    const { artifact, buildInfo, compiled } = await loadProductionEscrow();
    compiled.evm.bytecode.object = changeFirstByte(compiled.evm.bytecode.object);
    artifact.bytecode = `0x${compiled.evm.bytecode.object}`;
    assert.throws(
      () => createContractBundle(artifact, buildInfo, source),
      /creation bytecode differs/u,
    );
  });

  it('rejects changed runtime bytecode outside the compiler immutable references', async function () {
    const { artifact, buildInfo, compiled } = await loadProductionEscrow();
    compiled.evm.deployedBytecode.object = changeFirstByte(compiled.evm.deployedBytecode.object);
    artifact.deployedBytecode = `0x${compiled.evm.deployedBytecode.object}`;
    assert.throws(
      () => createContractBundle(artifact, buildInfo, source),
      /normalized runtime differs/u,
    );
  });

  it('normalizes only the compiler-declared immutable bytes', function () {
    const immutables = { value: [{ start: 1, length: 2 }] };
    assert.equal(normalizeRuntimeBytecode('0xabcdef12', immutables), '0xab000012');
    assert.equal(normalizeRuntimeBytecode('abcdef12', immutables), '0xab000012');
  });
});
