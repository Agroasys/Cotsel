/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'ethers';
import { Config } from '../src/config';
import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_ENV_VARS = [
  'RPC_URL',
  'CHAIN_ID',
  'ESCROW_ADDRESS',
  'USDC_ADDRESS',
  'BUYER_PRIVATE_KEY',
  'ORACLE_PRIVATE_KEY',
  'ADMIN1_PRIVATE_KEY',
  'ADMIN2_PRIVATE_KEY',
] as const;

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const missingRequiredEnv = REQUIRED_ENV_VARS.filter((key) => !readEnv(key));
export const hasRequiredEnv = missingRequiredEnv.length === 0;

export function assertRequiredEnv(): void {
  if (hasRequiredEnv) return;

  throw new Error(
    `Missing required SDK integration environment variables: ${missingRequiredEnv.join(', ')}. ` +
      'Copy sdk/.env.example to sdk/.env and set all values.',
  );
}

export function getOptionalEnv(key: string): string | undefined {
  return readEnv(key);
}

function getRequiredEnv(key: string): string {
  const value = readEnv(key);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        'Copy sdk/.env.example to sdk/.env and set all values.',
    );
  }
  return value;
}

export const TEST_CONFIG: Config = {
  rpc: readEnv('RPC_URL') ?? '',
  chainId: Number(readEnv('CHAIN_ID') ?? 0),
  escrowAddress: readEnv('ESCROW_ADDRESS') ?? '',
  usdcAddress: readEnv('USDC_ADDRESS') ?? '',
};

export function getBuyerSigner(): ethers.Wallet {
  const privateKey = getRequiredEnv('BUYER_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(TEST_CONFIG.rpc);
  return new ethers.Wallet(privateKey, provider);
}

export function getOracleSigner(): ethers.Wallet {
  const privateKey = getRequiredEnv('ORACLE_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(TEST_CONFIG.rpc);
  return new ethers.Wallet(privateKey, provider);
}

export function getAdminSigner(id: number): ethers.Wallet {
  const privateKey =
    id === 1 ? getRequiredEnv('ADMIN1_PRIVATE_KEY') : getRequiredEnv('ADMIN2_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(TEST_CONFIG.rpc);
  return new ethers.Wallet(privateKey, provider);
}

export function generateTestRicardianHash(content: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(content));
}

export function parseUSDC(amount: string): bigint {
  return ethers.parseUnits(amount, 6);
}
