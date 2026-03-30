// SPDX-License-Identifier: Apache-2.0
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import type { HttpNetworkConfig } from "hardhat/types";

const DEPLOY_ARGS = {
  usdcAddress: "0xEea5766E43D0c7032463134Afc121e63C9f9C260",
  oracleAddress: "0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D",
  treasuryAddress: "0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D",
  admins: [
    "0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D",
    "0x229C75F0cD13D6ab7621403Bd951a9e43ba53b1e",
    "0x4aF052cB4B3eC7b58322548021bF254Cc4c80b2c",
  ],
  requiredApprovals: 2,
} as const;

async function main(): Promise<void> {
  const hre = require("hardhat");
  const networkConfig = hre.network.config as HttpNetworkConfig;

  const accounts = networkConfig.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error(
      "No private key found for polkadotTestnet. " +
      "Set it with: npx hardhat vars set PRIVATE_KEY"
    );
  }
  const privateKey = accounts[0] as string;
  const rpcUrl = networkConfig.url;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const artifactPath = path.join(
    __dirname,
    "../artifacts/src/AgroasysEscrow.sol/AgroasysEscrow.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Artifact not found at ${artifactPath}. ` +
      "Run 'npm run compile:polkavm:historical' first."
    );
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    _format: string;
    contractName: string;
    abi: any[];
    bytecode: string;
  };

  if (artifact._format !== "hh-resolc-artifact-1") {
    throw new Error(
      `Expected resolc artifact (hh-resolc-artifact-1), found '${artifact._format}'. ` +
      "Run 'npm run compile:polkavm:historical' to produce archived PVM bytecode."
    );
  }

  const byteLen = (artifact.bytecode.length - 2) / 2;
  const EVM_CAP = 49_152;

  console.log("=== AgroasysEscrow PolkaVM Deploy ===");
  console.log(`Deployer   : ${wallet.address}`);
  console.log(`Network    : ${rpcUrl}`);
  console.log(`Artifact   : ${artifact._format}`);
  console.log(
    `Bytecode   : ${byteLen.toLocaleString()} bytes (${(byteLen / 1024).toFixed(1)} KB)` +
    (byteLen > EVM_CAP ? ` — OK for PVM` : "")
  );
  console.log("");

  const balance = await provider.getBalance(wallet.address);
  console.log(`Balance    : ${ethers.formatEther(balance)} PAS`);
  if (balance === 0n) {
    throw new Error("Deployer balance is 0. Fund the account from the Polkadot faucet first.");
  }

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log("\nDeploying...");
  const contract = await factory.deploy(
    DEPLOY_ARGS.usdcAddress,
    DEPLOY_ARGS.oracleAddress,
    DEPLOY_ARGS.treasuryAddress,
    DEPLOY_ARGS.admins,
    DEPLOY_ARGS.requiredApprovals,
  );

  const deployTx = contract.deploymentTransaction();
  console.log(`Tx hash    : ${deployTx?.hash}`);
  console.log("Waiting for confirmation...");

  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  console.log("");
  console.log("=== Deployment complete ===");
  console.log(`Contract   : ${addr}`);
  console.log(`Network    : polkadotTestnet (chainId 420420417)`);
  console.log("");
  console.log("Next step: run the polkadot-deploy-verify script to confirm on-chain bytecode matches the artifact.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
