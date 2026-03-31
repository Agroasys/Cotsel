/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { vars } from 'hardhat/config';

function optionalVar(name: string): string | undefined {
  const envValue = process.env[name]?.trim();
  if (envValue) {
    return envValue;
  }

  try {
    const v = vars.get(name);
    return v && v.trim() ? v : undefined;
  } catch {
    return undefined;
  }
}

const pk1 = optionalVar("PRIVATE_KEY");
const pk2 = optionalVar("PRIVATE_KEY2");
const deployerAccounts = [pk1, pk2].filter(Boolean) as string[];

const baseSepoliaRpcUrl = optionalVar("BASE_SEPOLIA_RPC_URL") ?? "https://sepolia.base.org";
const baseMainnetRpcUrl = optionalVar("BASE_MAINNET_RPC_URL") ?? "https://mainnet.base.org";
const etherscanApiKey = optionalVar("ETHERSCAN_API_KEY") ?? optionalVar("BASESCAN_API_KEY") ?? "PLACEHOLDER";

const config: HardhatUserConfig = {
  solidity: {
    version:"0.8.34",
    settings: {
      viaIR:true,
      optimizer: {
        enabled: true,
        runs: 200,
      }
    }
  },
  paths: {
    sources: "./src",
    tests: "./tests",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    hardhat: {},
    baseSepolia: {
      url: baseSepoliaRpcUrl,
      chainId: 84532,
      accounts: deployerAccounts,
    },
    "base-sepolia": {
      url: baseSepoliaRpcUrl,
      chainId: 84532,
      accounts: deployerAccounts,
    },
    base: {
      url: baseMainnetRpcUrl,
      chainId: 8453,
      accounts: deployerAccounts,
    },
    "base-mainnet": {
      url: baseMainnetRpcUrl,
      chainId: 8453,
      accounts: deployerAccounts,
    },
  },
  etherscan: {
    apiKey: etherscanApiKey,
  },
};

export default config;
