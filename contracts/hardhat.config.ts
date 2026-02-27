/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { vars } from 'hardhat/config';

const usePolkavmResolc = process.env.USE_POLKAVM_RESOLC === "true";
if (usePolkavmResolc) {
  require("@parity/hardhat-polkadot");
  require("@parity/hardhat-polkadot-resolc");
}

function optionalVar(name: string): string | undefined {
  try {
    const v = vars.get(name);
    return v && v.trim() ? v : undefined;
  } catch {
    return undefined;
  }
}

const pk1 = optionalVar("PRIVATE_KEY");
const pk2 = optionalVar("PRIVATE_KEY2");
const polkadotAccounts = [pk1, pk2].filter(Boolean) as string[];

const config: HardhatUserConfig = {
  solidity: {
    version:"0.8.28",
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
    polkadotTestnet: {
      url: 'https://services.polkadothub-rpc.com/testnet',
      chainId: 420420417,
      accounts: polkadotAccounts,
      polkadot: { target: "pvm" },
    } as any,
  },
};

if (usePolkavmResolc) {
  (config as HardhatUserConfig & { resolc?: unknown }).resolc = {
    version: "1.0.0",
    compilerSource: "binary",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  };
}

export default config;
