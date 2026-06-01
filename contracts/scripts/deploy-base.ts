// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import hre, { ethers } from 'hardhat';
import { loadBaseDeploymentConfig } from './lib/baseDeploymentConfig';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function getCommitSha(): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: path.join(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
  } catch {
    return 'unknown';
  }
}

function getConfiguredCompilerVersion(): string | null {
  if (typeof hre.config.solidity === 'string') {
    return hre.config.solidity;
  }

  if ('version' in hre.config.solidity && typeof hre.config.solidity.version === 'string') {
    return hre.config.solidity.version;
  }

  if ('compilers' in hre.config.solidity && Array.isArray(hre.config.solidity.compilers)) {
    const primaryCompiler = hre.config.solidity.compilers[0];
    if (primaryCompiler && typeof primaryCompiler.version === 'string') {
      return primaryCompiler.version;
    }
  }

  return null;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeployedBytecode(contractAddress: string): Promise<string> {
  const attempts = parsePositiveIntEnv('DEPLOY_BYTECODE_WAIT_ATTEMPTS', 12);
  const delayMs = parsePositiveIntEnv('DEPLOY_BYTECODE_WAIT_DELAY_MS', 5000);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const bytecode = await ethers.provider.getCode(contractAddress);
    if (bytecode !== '0x') {
      return bytecode;
    }

    if (attempt < attempts) {
      console.log(
        `Bytecode not visible yet at ${contractAddress}; retrying in ${delayMs}ms (${attempt}/${attempts})`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(
    `No deployed bytecode found at ${contractAddress} after ${attempts} attempts. Check the deployment transaction receipt before retrying verification.`,
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyVerified(message: string): boolean {
  return /already verified/i.test(message);
}

function isTransientBytecodeVisibilityError(message: string): boolean {
  return /DeployedBytecodeNotFoundError|has no bytecode|bytecode.*not.*found/i.test(message);
}

async function verifyWithRetries(
  contractAddress: string,
  constructorArguments: readonly unknown[],
): Promise<'verified' | 'already-verified'> {
  const attempts = parsePositiveIntEnv('DEPLOY_VERIFY_ATTEMPTS', 6);
  const delayMs = parsePositiveIntEnv('DEPLOY_VERIFY_RETRY_DELAY_MS', 10000);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await hre.run('verify:verify', {
        address: contractAddress,
        constructorArguments,
      });

      return 'verified';
    } catch (error) {
      const message = getErrorMessage(error);
      if (isAlreadyVerified(message)) {
        return 'already-verified';
      }

      if (isTransientBytecodeVisibilityError(message) && attempt < attempts) {
        console.log(
          `Verification could not see deployed bytecode yet; retrying in ${delayMs}ms (${attempt}/${attempts})`,
        );
        await sleep(delayMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error('Verification retries exhausted unexpectedly');
}

async function main(): Promise<void> {
  const chainId = hre.network.config.chainId ?? null;
  const config = loadBaseDeploymentConfig(hre.network.name, chainId);
  const artifact = await hre.artifacts.readArtifact(config.escrowName);
  const configuredCompilerVersion = getConfiguredCompilerVersion();
  const [deployer] = await ethers.getSigners();

  if (!deployer) {
    throw new Error(
      `No deployer account configured for ${hre.network.name}. Set Hardhat vars PRIVATE_KEY/PRIVATE_KEY2.`,
    );
  }

  const deployArgs = [
    config.usdcAddress,
    config.oracleAddress,
    config.treasuryAddress,
    config.relayerAddress,
    config.admins,
    config.requiredApprovals,
  ] as const;

  console.log('=== AgroasysEscrow Base deploy ===');
  console.log(`Network           : ${config.target.networkName} (${config.target.chainId})`);
  console.log(`Deployer          : ${deployer.address}`);
  console.log(`USDC              : ${config.usdcAddress}`);
  console.log(`Oracle            : ${config.oracleAddress}`);
  console.log(`Treasury          : ${config.treasuryAddress}`);
  console.log(`Relayer           : ${config.relayerAddress}`);
  console.log(`Admins            : ${config.admins.join(', ')}`);
  console.log(`Required approvals: ${config.requiredApprovals}`);
  console.log(`Verify            : ${config.verify}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance === 0n) {
    throw new Error(
      `Deployer balance is 0 on ${config.target.networkName}. Fund the account before deployment.`,
    );
  }

  const factory = await ethers.getContractFactory(config.escrowName, deployer);
  const contract = await factory.deploy(...deployArgs);
  const deploymentTx = contract.deploymentTransaction();
  if (!deploymentTx) {
    throw new Error('Deployment transaction was not created');
  }

  console.log(`Deployment tx     : ${deploymentTx.hash}`);
  console.log(`Confirmations     : ${config.confirmations}`);
  await deploymentTx.wait(config.confirmations);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  const deployedBytecode = await waitForDeployedBytecode(contractAddress);
  const explorerAddressUrl = `${config.target.explorerBaseUrl}${contractAddress}`;
  const verificationUrl = `${explorerAddressUrl}#code`;

  let verificationStatus: 'skipped' | 'verified' | 'already-verified' = 'skipped';
  if (config.verify) {
    verificationStatus = await verifyWithRetries(contractAddress, deployArgs);
  }

  const bundle = {
    generatedAt: new Date().toISOString(),
    commitSha: getCommitSha(),
    network: {
      hardhatName: hre.network.name,
      runtimeKey: config.target.runtimeKey,
      displayName: config.target.networkName,
      chainId: config.target.chainId,
    },
    contract: {
      name: config.escrowName,
      address: contractAddress,
      deploymentTxHash: deploymentTx.hash,
      explorerAddressUrl,
      constructorArguments: {
        usdcAddress: config.usdcAddress,
        oracleAddress: config.oracleAddress,
        treasuryAddress: config.treasuryAddress,
        relayerAddress: config.relayerAddress,
        admins: config.admins,
        requiredApprovals: config.requiredApprovals,
      },
    },
    verification: {
      requested: config.verify,
      status: verificationStatus,
      verificationUrl: config.verify ? verificationUrl : null,
    },
    artifact: {
      compilerVersion: configuredCompilerVersion,
      abiSha256: sha256Hex(JSON.stringify(artifact.abi)),
      bytecodeSha256: sha256Hex(artifact.bytecode),
      deployedBytecodeSha256: sha256Hex(deployedBytecode),
    },
  };

  fs.mkdirSync(config.evidenceOutDir, { recursive: true });
  const outputPath = path.join(
    config.evidenceOutDir,
    `${config.escrowName.toLowerCase()}-deploy.json`,
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  console.log(`Contract address  : ${contractAddress}`);
  console.log(`Explorer URL      : ${explorerAddressUrl}`);
  console.log(`Verification      : ${verificationStatus}`);
  console.log(`Evidence bundle   : ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
