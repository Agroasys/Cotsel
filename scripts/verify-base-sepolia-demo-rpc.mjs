#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateBaseSepoliaSelection } from './validate-base-sepolia-staging-contract.mjs';

const endpoints = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
const selectors = {
  usdc: '0x11eac855',
  oracle: '0xa89ae4ba',
  treasury: '0xc5f956af',
  treasuryPayout: '0xf5ecef57',
  approvals: '0x99c1aadc',
  epoch: '0x9840bde7',
  oracleActive: '0x86f23a35',
  relayer: '0x541d5548',
  admin: '0x24d7806c',
  adminAt: '0x14bfd6d0',
};
const normalize = (value) => String(value).toLowerCase();
const requireEqual = (actual, expected, name) => {
  if (actual !== expected) throw new Error(`Demo on-chain ${name} mismatch`);
};
const addressWord = (address) => normalize(address).slice(2).padStart(64, '0');
const integerWord = (value) => BigInt(value).toString(16).padStart(64, '0');

export async function verifyDemoOnchain({ manifest, deployment, preparation, rpc }) {
  requireEqual(await rpc('eth_chainId', []), '0x14a34', 'chain');
  const head = BigInt(await rpc('eth_blockNumber', []));
  if (head < BigInt(manifest.deploymentBlock) + 12n)
    throw new Error('Demo deployment needs 12 confirming blocks');
  const tx = await rpc('eth_getTransactionByHash', [manifest.deploymentTransactionHash]);
  if (!tx) throw new Error('Demo deployment transaction is unavailable');
  requireEqual(normalize(tx.from), normalize(preparation.transaction.from), 'signer');
  requireEqual(tx.to, null, 'transaction recipient');
  requireEqual(BigInt(tx.value), 0n, 'transaction value');
  requireEqual(BigInt(tx.nonce), BigInt(preparation.transaction.nonce), 'transaction nonce');
  requireEqual(normalize(tx.input), normalize(preparation.transaction.data), 'transaction input');
  const receipt = await rpc('eth_getTransactionReceipt', [manifest.deploymentTransactionHash]);
  if (!receipt) throw new Error('Demo deployment receipt is unavailable');
  requireEqual(BigInt(receipt.status), 1n, 'receipt status');
  requireEqual(BigInt(receipt.blockNumber), BigInt(manifest.deploymentBlock), 'deployment block');
  requireEqual(
    normalize(receipt.transactionHash),
    normalize(manifest.deploymentTransactionHash),
    'receipt transaction',
  );
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  if (!block?.hash) throw new Error('Demo deployment block is unavailable');
  requireEqual(normalize(receipt.blockHash), normalize(block.hash), 'canonical block');
  requireEqual(normalize(tx.blockHash), normalize(block.hash), 'transaction block');
  requireEqual(normalize(receipt.contractAddress), normalize(manifest.address), 'contract address');
  const code = await rpc('eth_getCode', [manifest.address, 'latest']);
  if (typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code))
    throw new Error('Demo contract code is unavailable');
  requireEqual(
    createHash('sha256').update(code).digest('hex'),
    deployment.artifact.liveRuntimeBytecodeSha256,
    'runtime code',
  );
  const call = (data) => rpc('eth_call', [{ to: manifest.address, data }, 'latest']);
  const addressResult = (value) => normalize(value).slice(-40);
  for (const [selector, expected] of [
    [selectors.usdc, manifest.usdcAddress],
    [selectors.oracle, manifest.roles.oracle],
    [selectors.treasury, manifest.roles.treasury],
    [selectors.treasuryPayout, manifest.roles.treasuryPayout],
  ]) {
    requireEqual(addressResult(await call(selector)), normalize(expected).slice(2), 'role address');
  }
  requireEqual(
    BigInt(await call(selectors.approvals)),
    BigInt(manifest.roles.requiredApprovals),
    'approval threshold',
  );
  requireEqual(
    BigInt(await call(selectors.epoch)),
    BigInt(manifest.roles.governanceEpoch),
    'governance epoch',
  );
  requireEqual(BigInt(await call(selectors.oracleActive)), 1n, 'oracle status');
  requireEqual(
    BigInt(await call(selectors.relayer + addressWord(manifest.roles.relayer))),
    1n,
    'relayer role',
  );
  for (const [index, admin] of manifest.roles.admins.entries()) {
    requireEqual(
      BigInt(await call(selectors.admin + addressWord(admin))),
      1n,
      'administrator role',
    );
    requireEqual(
      addressResult(await call(selectors.adminAt + integerWord(index))),
      normalize(admin).slice(2),
      'administrator order',
    );
  }
}

async function main() {
  const [manifestPath, deploymentPath, preparationPath, expectedCodehash, expectedAbi] =
    process.argv.slice(2);
  if (!manifestPath || !deploymentPath || !preparationPath || !expectedCodehash || !expectedAbi)
    throw new Error('Demo on-chain verification inputs are missing');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
  const preparation = JSON.parse(readFileSync(preparationPath, 'utf8'));
  validateBaseSepoliaSelection({
    manifest,
    deployment,
    preparation,
    requested: {
      address: manifest.address,
      deploymentBlock: manifest.deploymentBlock,
      usdcAddress: manifest.usdcAddress,
    },
  });
  if (manifest.schemaVersion !== 'cotsel.base-sepolia-staging-demo.v1')
    throw new Error('Expected the test-only demo manifest');
  requireEqual(
    normalize(expectedCodehash),
    normalize(manifest.runtimeCodehash),
    'requested runtime codehash',
  );
  requireEqual(expectedAbi, manifest.indexerAbiFingerprint, 'requested ABI fingerprint');
  for (const [index, endpoint] of endpoints.entries()) {
    let id = 0;
    const rpc = async (method, params) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Demo witness ${index + 1} HTTP ${response.status}`);
      const data = await response.json();
      if (data.error || !Object.hasOwn(data, 'result'))
        throw new Error(`Demo witness ${index + 1} rejected ${method}`);
      return data.result;
    };
    await verifyDemoOnchain({ manifest, deployment, preparation, rpc });
    process.stdout.write(`Demo witness ${index + 1}: transaction, code, and roles match.\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
