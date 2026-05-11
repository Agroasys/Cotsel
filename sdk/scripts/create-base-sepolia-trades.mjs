#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createRequire } from 'node:module';
import process from 'node:process';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);

let BuyerSDK;
try {
  ({ BuyerSDK } = require('../dist/index.js'));
} catch (error) {
  throw new Error(
    `Could not load sdk/dist/index.js. Run "npm run build -w sdk" before this script. ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_DECIMALS = 6;

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > -1) {
      args[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

function readValue(args, argName, envNames, fallback = null) {
  const argValue = args[argName];
  if (typeof argValue === 'string' && argValue.trim().length > 0) {
    return argValue.trim();
  }

  for (const envName of envNames) {
    const value = process.env[envName]?.trim();
    if (value) return value;
  }

  return fallback;
}

function requireValue(args, argName, envNames) {
  const value = readValue(args, argName, envNames);
  if (!value) {
    throw new Error(`Missing --${argName} or one of: ${envNames.join(', ')}`);
  }
  return value;
}

function requireEnvValue(args, argName, envName) {
  if (Object.prototype.hasOwnProperty.call(args, argName)) {
    throw new Error(
      `Do not pass --${argName}. Set ${envName} in the environment so the key is not exposed through shell history or process listings.`,
    );
  }

  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${envName}`);
  }
  return value;
}

function parsePositiveInt(name, raw, fallback) {
  const value = raw ?? String(fallback);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parseUsdcAmount(name, raw, fallback) {
  const value = raw ?? fallback;
  try {
    const parsed = ethers.parseUnits(value, USDC_DECIMALS);
    if (parsed <= 0n) {
      throw new Error('amount must be positive');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${name} must be a positive USDC decimal string, got ${value}. ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function parseAddress(name, value) {
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address, got ${value}`);
  }
  return ethers.getAddress(value);
}

function splitFallbackUrls(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildTradePayload({ supplier, totalAmount, label }) {
  const logisticsAmount = totalAmount / 10n;
  const platformFeesAmount = totalAmount / 20n;
  const supplierFirstTranche = (totalAmount * 40n) / 100n;
  const supplierSecondTranche =
    totalAmount - logisticsAmount - platformFeesAmount - supplierFirstTranche;

  if (supplierFirstTranche <= 0n || supplierSecondTranche <= 0n) {
    throw new Error('Trade amount is too small to split into positive supplier tranches');
  }

  return {
    supplier,
    totalAmount,
    logisticsAmount,
    platformFeesAmount,
    supplierFirstTranche,
    supplierSecondTranche,
    ricardianHash: ethers.keccak256(ethers.toUtf8Bytes(label)),
  };
}

function formatUsdc(value) {
  return ethers.formatUnits(value, USDC_DECIMALS);
}

const args = parseArgs(process.argv.slice(2));

const rpc =
  readValue(args, 'rpc-url', [
    'RPC_URL',
    'GATEWAY_RPC_URL',
    'ORACLE_RPC_URL',
    'INDEXER_RPC_ENDPOINT',
  ]) ?? readValue(args, 'rpc', ['BASE_SEPOLIA_RPC_URL', 'VITE_RPC_URL'], BASE_SEPOLIA_RPC_URL);
const rpcFallbackUrls = splitFallbackUrls(
  readValue(args, 'rpc-fallback-urls', [
    'RPC_FALLBACK_URLS',
    'GATEWAY_RPC_FALLBACK_URLS',
    'ORACLE_RPC_FALLBACK_URLS',
  ]),
);
const chainId = parsePositiveInt(
  'chain id',
  readValue(args, 'chain-id', ['CHAIN_ID', 'GATEWAY_CHAIN_ID', 'ORACLE_CHAIN_ID']),
  BASE_SEPOLIA_CHAIN_ID,
);
const escrowAddress = parseAddress(
  'escrow address',
  requireValue(args, 'escrow-address', [
    'ESCROW_ADDRESS',
    'GATEWAY_ESCROW_ADDRESS',
    'INDEXER_CONTRACT_ADDRESS',
  ]),
);
const usdcAddress = parseAddress(
  'USDC address',
  readValue(
    args,
    'usdc-address',
    ['USDC_ADDRESS', 'GATEWAY_USDC_ADDRESS', 'ORACLE_USDC_ADDRESS'],
    BASE_SEPOLIA_USDC,
  ),
);
const supplier = parseAddress(
  'supplier address',
  requireValue(args, 'supplier-address', ['SUPPLIER_ADDRESS']),
);
const buyerPrivateKey = requireEnvValue(args, 'buyer-private-key', 'BUYER_PRIVATE_KEY');
const expectedBuyerAddress = readValue(args, 'buyer-address', ['BUYER_ADDRESS']);
const amountInput =
  readValue(args, 'amount-usdc', ['TRADE_AMOUNT_USDC']) ??
  readValue(args, 'total-usdc', ['TRADE_TOTAL_USDC']);
const totalAmount = parseUsdcAmount('trade total', amountInput, '1');
const labelPrefix = readValue(args, 'label-prefix', ['TRADE_LABEL_PREFIX'], 'COTSEL-DASH-167');

if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
  throw new Error(`This helper is for Base Sepolia only. Expected chain id 84532, got ${chainId}`);
}

const provider = new ethers.JsonRpcProvider(rpc, chainId);
const buyerSigner = new ethers.Wallet(buyerPrivateKey, provider);
const buyerAddress = await buyerSigner.getAddress();
if (
  expectedBuyerAddress &&
  parseAddress('buyer address', expectedBuyerAddress).toLowerCase() !== buyerAddress.toLowerCase()
) {
  throw new Error(
    `BUYER_PRIVATE_KEY resolves to ${buyerAddress}, but buyer address was set to ${expectedBuyerAddress}`,
  );
}
const usdc = new ethers.Contract(usdcAddress, USDC_ABI, provider);

const [network, nativeBalance, usdcBalance, allowance] = await Promise.all([
  provider.getNetwork(),
  provider.getBalance(buyerAddress),
  usdc.balanceOf(buyerAddress),
  usdc.allowance(buyerAddress, escrowAddress),
]);

if (network.chainId !== BigInt(chainId)) {
  throw new Error(`RPC is connected to chain ${network.chainId}, expected ${chainId}`);
}

if (usdcBalance < totalAmount) {
  throw new Error(
    `Buyer has ${formatUsdc(usdcBalance)} USDC, but ${formatUsdc(totalAmount)} USDC is required`,
  );
}

if (nativeBalance === 0n) {
  throw new Error('Buyer has no Base Sepolia ETH for gas');
}

console.log('Base Sepolia trade creation preflight');
console.log(`buyer: ${buyerAddress}`);
console.log(`supplier: ${supplier}`);
console.log(`escrow: ${escrowAddress}`);
console.log(`usdc: ${usdcAddress}`);
console.log(`buyer ETH: ${ethers.formatEther(nativeBalance)}`);
console.log(`buyer USDC: ${formatUsdc(usdcBalance)}`);
console.log(`current allowance: ${formatUsdc(allowance)}`);
console.log(`creating one trade at ${formatUsdc(totalAmount)} USDC`);

const buyerSDK = new BuyerSDK({
  rpc,
  rpcFallbackUrls,
  chainId,
  escrowAddress,
  usdcAddress,
});

const label = `${labelPrefix}-${new Date().toISOString()}`;
const payload = buildTradePayload({ supplier, totalAmount, label });

console.log('\nCreating trade...');
const result = await buyerSDK.createTrade(payload, buyerSigner);

console.log('\nCreated trade:');
console.log(
  JSON.stringify(
    {
      tradeId: result.tradeId ?? null,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      buyer: buyerAddress,
      supplier,
      totalUsdc: formatUsdc(totalAmount),
      ricardianHash: payload.ricardianHash,
    },
    null,
    2,
  ),
);
