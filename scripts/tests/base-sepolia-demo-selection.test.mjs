import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateBaseSepoliaSelection } from '../validate-base-sepolia-staging-contract.mjs';
import { verifyDemoOnchain } from '../verify-base-sepolia-demo-rpc.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const originalManifest = read('integration/base-sepolia-demo-contract.json');
const originalDeployment = read('contracts/reports/deploy/base-sepolia/demo-deployment.json');
const originalPreparation = read('contracts/reports/deploy/base-sepolia/demo-preparation.json');
const input = () => ({
  demoExplicit: true,
  manifest: structuredClone(originalManifest),
  deployment: structuredClone(originalDeployment),
  preparation: structuredClone(originalPreparation),
  requested: {
    address: originalManifest.address,
    deploymentBlock: originalManifest.deploymentBlock,
    usdcAddress: originalManifest.usdcAddress,
  },
});

test('the owner-authorized demo is distinct from independently accepted staging', () => {
  const x = input();
  assert.equal(validateBaseSepoliaSelection(x).chainId, 84532);
  assert.notEqual(x.manifest.sourceCommit, x.manifest.finalizerCommit);
  assert.equal(x.manifest.custodyAttestation, 'unattested');
});

test('demo selection rejects altered input, custody claims, chain, address and verifier identity', () => {
  for (const mutate of [
    (x) => {
      x.demoExplicit = false;
    },
    (x) => {
      x.preparation.transaction.data += '00';
    },
    (x) => {
      x.preparation.commitSha = '0'.repeat(40);
    },
    (x) => {
      x.manifest.custodyAttestation = 'hardware-wallet';
    },
    (x) => {
      x.manifest.chainId = 8453;
    },
    (x) => {
      x.manifest.address = '0x1111111111111111111111111111111111111111';
    },
    (x) => {
      x.deployment.commitSha = '0'.repeat(40);
    },
  ]) {
    const x = input();
    mutate(x);
    assert.throws(() => validateBaseSepoliaSelection(x));
  }
});

function fixtureRpc(x, changes = {}) {
  const code = '0x60006000';
  x.deployment.artifact.liveRuntimeBytecodeSha256 = createHash('sha256').update(code).digest('hex');
  const word = (value) => `0x${value.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const values = {
    '0x11eac855': word(x.manifest.usdcAddress),
    '0xa89ae4ba': word(x.manifest.roles.oracle),
    '0xc5f956af': word(x.manifest.roles.treasury),
    '0xf5ecef57': word(x.manifest.roles.treasuryPayout),
    '0x99c1aadc': word('2'),
    '0x9840bde7': word('1'),
    '0x86f23a35': word('1'),
  };
  return async (method, params) => {
    if (method === 'eth_chainId') return changes.chain ?? '0x14a34';
    if (method === 'eth_blockNumber')
      return `0x${(x.manifest.deploymentBlock + (changes.confirmations ?? 12)).toString(16)}`;
    if (method === 'eth_getTransactionByHash')
      return {
        from: x.preparation.transaction.from,
        to: null,
        value: '0x0',
        nonce: '0x1b',
        blockHash: `0x${'ab'.repeat(32)}`,
        input: changes.input ?? x.preparation.transaction.data,
      };
    if (method === 'eth_getTransactionReceipt')
      return {
        status: '0x1',
        blockNumber: `0x${x.manifest.deploymentBlock.toString(16)}`,
        contractAddress: x.manifest.address,
        transactionHash: x.manifest.deploymentTransactionHash,
        blockHash: `0x${'ab'.repeat(32)}`,
      };
    if (method === 'eth_getBlockByNumber') return { hash: `0x${'ab'.repeat(32)}` };
    if (method === 'eth_getCode') return changes.code ?? code;
    if (method === 'eth_call') {
      const selector = params[0].data.slice(0, 10);
      if (selector === '0x541d5548' || selector === '0x24d7806c') return word('1');
      if (selector === '0x14bfd6d0')
        return word(x.manifest.roles.admins[Number(BigInt(`0x${params[0].data.slice(10)}`))]);
      if (selector === '0x9840bde7' && changes.epoch) return word(changes.epoch);
      return values[selector];
    }
    throw new Error('unexpected method');
  };
}

test('on-chain verification accepts matching transaction, code and roles', async () => {
  const x = input();
  await verifyDemoOnchain({ ...x, rpc: fixtureRpc(x) });
});

test('on-chain verification rejects wrong chain, transaction, bytecode or governance epoch', async () => {
  for (const changes of [
    { chain: '0x2105' },
    { confirmations: 1 },
    { input: '0x6000' },
    { code: '0x6001' },
    { epoch: '2' },
  ]) {
    const x = input();
    await assert.rejects(() => verifyDemoOnchain({ ...x, rpc: fixtureRpc(x, changes) }));
  }
});

function dispatchDemo(mode, tag = 'a'.repeat(40)) {
  const dir = mkdtempSync(join(tmpdir(), 'cotsel-demo-dispatch-'));
  try {
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'node'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALL_LOG"\n`, {
      mode: 0o755,
    });
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CALL_LOG: log,
      DEMO_MODE: mode,
      GATEWAY_IMAGE_TAG: tag,
      GITHUB_SHA: 'a'.repeat(40),
      BASE_SEPOLIA_ESCROW_ADDRESS: originalManifest.address,
      BASE_SEPOLIA_CONTRACT_START_BLOCK: String(originalManifest.deploymentBlock),
      BASE_SEPOLIA_USDC_ADDRESS: originalManifest.usdcAddress,
      BASE_SEPOLIA_ESCROW_CODEHASH: originalManifest.runtimeCodehash,
      ESCROW_ABI_FINGERPRINT: originalManifest.indexerAbiFingerprint,
    };
    const result = spawnSync('bash', ['scripts/validate-base-sepolia-selection.sh'], {
      env,
      encoding: 'utf8',
    });
    let calls = '';
    try {
      calls = readFileSync(log, 'utf8');
    } catch {
      calls = '';
    }
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the workflow requires explicit demo mode and the exact main image', () => {
  const regular = dispatchDemo('false');
  assert.equal(regular.status, 0);
  assert.match(regular.calls, /base-sepolia-staging-contract\.json/);
  assert.doesNotMatch(regular.calls, /demo-contract\.json/);
  const demo = dispatchDemo('true');
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.calls, /base-sepolia-demo-contract\.json/);
  assert.match(demo.calls, /verify-base-sepolia-demo-rpc\.mjs/);
  assert.notEqual(dispatchDemo('true', 'b'.repeat(40)).status, 0);
  assert.notEqual(dispatchDemo('unexpected').status, 0);
});
