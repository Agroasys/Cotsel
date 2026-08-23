/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
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

const pk1 = optionalVar('PRIVATE_KEY');
const pk2 = optionalVar('PRIVATE_KEY2');
const deployerAccounts = [pk1, pk2].filter(Boolean) as string[];

function requestedNetwork(): string | undefined {
  const networkFlag = process.argv.indexOf('--network');
  return networkFlag >= 0 ? process.argv[networkFlag + 1] : undefined;
}

function managedRpcUrl(variable: string, networkAliases: string[]): string | undefined {
  const value = optionalVar(variable);
  if (!value && networkAliases.includes(requestedNetwork() ?? '')) {
    throw new Error(
      `${variable} is required for ${requestedNetwork()}. ` +
        'Canonical Base network commands must not silently use a public RPC endpoint.',
    );
  }
  return value;
}

const baseSepoliaRpcUrl = managedRpcUrl('BASE_SEPOLIA_RPC_URL', ['baseSepolia', 'base-sepolia']);
const baseMainnetRpcUrl = managedRpcUrl('BASE_MAINNET_RPC_URL', ['base', 'base-mainnet']);
const etherscanApiKey = optionalVar('ETHERSCAN_API_KEY') ?? optionalVar('BASESCAN_API_KEY') ?? '';

const baseNetworks: HardhatUserConfig['networks'] = {};
if (baseSepoliaRpcUrl) {
  baseNetworks.baseSepolia = {
    url: baseSepoliaRpcUrl,
    chainId: 84532,
    accounts: deployerAccounts,
  };
  baseNetworks['base-sepolia'] = {
    url: baseSepoliaRpcUrl,
    chainId: 84532,
    accounts: deployerAccounts,
  };
}
if (baseMainnetRpcUrl) {
  baseNetworks.base = {
    url: baseMainnetRpcUrl,
    chainId: 8453,
    accounts: deployerAccounts,
  };
  baseNetworks['base-mainnet'] = {
    url: baseMainnetRpcUrl,
    chainId: 8453,
    accounts: deployerAccounts,
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.34',
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 1,
      },
    },
  },
  paths: {
    sources: './src',
    tests: './tests',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks: {
    hardhat: {
      blockGasLimit: 120_000_000,
      hardfork: 'cancun',
    },
    ...baseNetworks,
  },
  etherscan: {
    apiKey: etherscanApiKey,
  },
};

export default config;
