// SPDX-License-Identifier: Apache-2.0
import { getAddress, isAddress, isHexString } from 'ethers';

export interface HardwareWalletDeployerConfig {
  expectedAddress: string;
}

function requiredEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the hardware-wallet deployment path`);
  }
  return value;
}

export function loadHardwareWalletDeployerConfig(
  env: NodeJS.ProcessEnv = process.env,
): HardwareWalletDeployerConfig {
  if (env.PRIVATE_KEY?.trim() || env.PRIVATE_KEY2?.trim()) {
    throw new Error(
      'PRIVATE_KEY and PRIVATE_KEY2 must not be configured for the hardware-wallet deployment path',
    );
  }

  const rawExpectedAddress = requiredEnv('DEPLOYER_ADDRESS', env);
  if (!isAddress(rawExpectedAddress)) {
    throw new Error('DEPLOYER_ADDRESS must be a valid EVM address');
  }

  return { expectedAddress: getAddress(rawExpectedAddress) };
}

export function loadDeploymentTransactionHash(env: NodeJS.ProcessEnv = process.env): string {
  const hash = requiredEnv('DEPLOY_TRANSACTION_HASH', env);
  if (!isHexString(hash, 32)) {
    throw new Error('DEPLOY_TRANSACTION_HASH must be a 32-byte transaction hash');
  }
  return hash;
}

export function assertHardwareWalletDeploymentTransaction(input: {
  expectedDeployer: string;
  expectedData: string;
  from: string;
  to: string | null;
  data: string;
  value: bigint;
}): void {
  if (getAddress(input.from) !== getAddress(input.expectedDeployer)) {
    throw new Error('Deployment transaction signer does not match DEPLOYER_ADDRESS');
  }
  if (input.to !== null) {
    throw new Error('Deployment transaction must be a contract-creation transaction');
  }
  if (input.value !== 0n) {
    throw new Error('Deployment transaction must not transfer native value');
  }
  if (input.data.toLowerCase() !== input.expectedData.toLowerCase()) {
    throw new Error('Deployment transaction data does not match the reviewed constructor request');
  }
}
