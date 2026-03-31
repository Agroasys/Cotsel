// SPDX-License-Identifier: Apache-2.0
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import hre, { ethers } from "hardhat";
import { loadBaseDeploymentConfig } from "./lib/baseDeploymentConfig";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: path.join(__dirname, "..", ".."), stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const chainId = hre.network.config.chainId ?? null;
  const config = loadBaseDeploymentConfig(hre.network.name, chainId);
  const artifact = await hre.artifacts.readArtifact(config.escrowName);
  const configuredCompilerVersion =
    typeof hre.config.solidity === "string"
      ? hre.config.solidity
      : "version" in hre.config.solidity
        ? hre.config.solidity.version
        : null;
  const [deployer] = await ethers.getSigners();

  if (!deployer) {
    throw new Error(`No deployer account configured for ${hre.network.name}. Set Hardhat vars PRIVATE_KEY/PRIVATE_KEY2.`);
  }

  const deployArgs = [
    config.usdcAddress,
    config.oracleAddress,
    config.treasuryAddress,
    config.admins,
    config.requiredApprovals,
  ] as const;

  console.log("=== AgroasysEscrow Base deploy ===");
  console.log(`Network           : ${config.target.networkName} (${config.target.chainId})`);
  console.log(`Deployer          : ${deployer.address}`);
  console.log(`USDC              : ${config.usdcAddress}`);
  console.log(`Oracle            : ${config.oracleAddress}`);
  console.log(`Treasury          : ${config.treasuryAddress}`);
  console.log(`Admins            : ${config.admins.join(", ")}`);
  console.log(`Required approvals: ${config.requiredApprovals}`);
  console.log(`Verify            : ${config.verify}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance === 0n) {
    throw new Error(`Deployer balance is 0 on ${config.target.networkName}. Fund the account before deployment.`);
  }

  const factory = await ethers.getContractFactory(config.escrowName, deployer);
  const contract = await factory.deploy(...deployArgs);
  const deploymentTx = contract.deploymentTransaction();
  if (!deploymentTx) {
    throw new Error("Deployment transaction was not created");
  }

  console.log(`Deployment tx     : ${deploymentTx.hash}`);
  console.log(`Confirmations     : ${config.confirmations}`);
  await deploymentTx.wait(config.confirmations);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  const deployedBytecode = await ethers.provider.getCode(contractAddress);
  const explorerAddressUrl = `${config.target.explorerBaseUrl}${contractAddress}`;
  const verificationUrl = `${explorerAddressUrl}#code`;

  let verificationStatus: "skipped" | "verified" | "already-verified" = "skipped";
  if (config.verify) {
    try {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: deployArgs,
      });
      verificationStatus = "verified";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already verified/i.test(message)) {
        verificationStatus = "already-verified";
      } else {
        throw error;
      }
    }
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
  const outputPath = path.join(config.evidenceOutDir, `${config.escrowName.toLowerCase()}-deploy.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  console.log(`Contract address  : ${contractAddress}`);
  console.log(`Explorer URL      : ${explorerAddressUrl}`);
  console.log(`Verification      : ${verificationStatus}`);
  console.log(`Evidence bundle   : ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
