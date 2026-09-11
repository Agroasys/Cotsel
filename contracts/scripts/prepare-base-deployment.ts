// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import hre, { ethers } from 'hardhat';
import { loadBaseDeploymentConfig } from './lib/baseDeploymentConfig';
import { getDeploymentSourceIdentity } from './lib/deploymentSourceIdentity';
import { loadHardwareWalletDeployerConfig } from './lib/hardwareWalletContractDeployment';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function main(): Promise<void> {
  const repositoryRoot = path.join(__dirname, '..', '..');
  const sourceIdentity = getDeploymentSourceIdentity(repositoryRoot);
  const chainId = hre.network.config.chainId ?? null;
  const config = loadBaseDeploymentConfig(hre.network.name, chainId);
  const { expectedAddress: deployerAddress } = loadHardwareWalletDeployerConfig();
  const runtimeRoles = [
    config.oracleAddress,
    config.treasuryAddress,
    config.relayerAddress,
    ...config.admins,
  ];
  if (runtimeRoles.some((role) => sameAddress(role, deployerAddress))) {
    throw new Error('The deployment wallet must not also hold a contract runtime role');
  }

  const artifact = await hre.artifacts.readArtifact(config.escrowName);
  const deployArgs = [
    config.usdcAddress,
    config.oracleAddress,
    config.treasuryAddress,
    config.relayerAddress,
    config.admins,
    config.requiredApprovals,
  ] as const;
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
  const transaction = await factory.getDeployTransaction(...deployArgs);
  if (typeof transaction.data !== 'string') {
    throw new Error('Deployment transaction data was not created');
  }

  const nonce = await ethers.provider.getTransactionCount(deployerAddress, 'pending');
  const gasLimit = await ethers.provider.estimateGas({
    from: deployerAddress,
    data: transaction.data,
    value: 0n,
  });
  const expectedContractAddress = ethers.getCreateAddress({ from: deployerAddress, nonce });
  const request = {
    generatedAt: new Date().toISOString(),
    commitSha: sourceIdentity.commitSha,
    worktreeClean: sourceIdentity.worktreeClean,
    custody: 'hardware-wallet',
    network: {
      hardhatName: hre.network.name,
      displayName: config.target.networkName,
      chainId: config.target.chainId,
    },
    transaction: {
      from: deployerAddress,
      to: null,
      value: '0',
      nonce,
      gasLimit: gasLimit.toString(),
      data: transaction.data,
      dataSha256: sha256Hex(transaction.data),
      expectedContractAddress,
    },
    constructorArguments: {
      usdcAddress: config.usdcAddress,
      oracleAddress: config.oracleAddress,
      treasuryAddress: config.treasuryAddress,
      relayerAddress: config.relayerAddress,
      admins: config.admins,
      requiredApprovals: config.requiredApprovals,
    },
    signingInstruction:
      'Review every field, then sign and broadcast this exact contract-creation transaction with the approved deployer hardware wallet.',
  };

  fs.mkdirSync(config.evidenceOutDir, { recursive: true });
  const outputPath = path.join(
    config.evidenceOutDir,
    `${config.escrowName.toLowerCase()}-deployment-request.json`,
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

  console.log(`Deployment wallet : ${deployerAddress}`);
  console.log(`Pending nonce     : ${nonce}`);
  console.log(`Expected contract : ${expectedContractAddress}`);
  console.log(`Request bundle    : ${outputPath}`);
  console.log('No transaction was signed or broadcast.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
