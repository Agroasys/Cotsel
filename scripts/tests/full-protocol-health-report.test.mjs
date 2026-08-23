import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildStaticProtocolReport,
  normalizeUrl,
  parseEnvContent,
  validateCandidateDeployReport,
} from '../lib/full-protocol-health-report.mjs';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-protocol-health-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@agroasys/cotsel',
      packageManager: 'pnpm@10.34.4',
      workspaces: ['gateway', 'auth'],
    }),
  );
  fs.mkdirSync(path.join(root, 'gateway'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'gateway', 'package.json'),
    JSON.stringify({ name: '@agroasys/gateway', version: '1.2.3' }),
  );
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'auth', 'package.json'),
    JSON.stringify({ name: '@agroasys/auth', version: '4.5.6' }),
  );
  return root;
}

test('parseEnvContent handles comments, empty lines, and quoted values', () => {
  assert.deepEqual(
    parseEnvContent(`
# comment
GATEWAY_CHAIN_ID=84532
GATEWAY_ESCROW_ADDRESS="0x1111111111111111111111111111111111111111"
EMPTY=''
`),
    {
      GATEWAY_CHAIN_ID: '84532',
      GATEWAY_ESCROW_ADDRESS: '0x1111111111111111111111111111111111111111',
      EMPTY: '',
    },
  );
});

test('normalizeUrl appends routed API suffix once', () => {
  assert.equal(
    normalizeUrl('http://127.0.0.1:3600', '/api/dashboard-gateway/v1'),
    'http://127.0.0.1:3600/api/dashboard-gateway/v1',
  );
  assert.equal(
    normalizeUrl('http://127.0.0.1:3600/api/dashboard-gateway/v1/', '/api/dashboard-gateway/v1'),
    'http://127.0.0.1:3600/api/dashboard-gateway/v1',
  );
});

test('buildStaticProtocolReport passes for consistent Base Sepolia profile truth', () => {
  const root = fixtureRepo();
  const escrow = '0xd2FB11ba1D95F1dF165b45Deb1B12c538fa920d4';
  fs.writeFileSync(
    path.join(root, '.env.runtime'),
    [
      'STAGING_E2E_REAL_NETWORK_NAME=Base Sepolia',
      'STAGING_E2E_REAL_CHAIN_ID=84532',
      'GATEWAY_SETTLEMENT_RUNTIME=base-sepolia',
      `GATEWAY_ESCROW_ADDRESS=${escrow}`,
      `ORACLE_ESCROW_ADDRESS=${escrow}`,
      `RECONCILIATION_ESCROW_ADDRESS=${escrow}`,
      `INDEXER_CONTRACT_ADDRESS=${escrow}`,
      'GATEWAY_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      'ORACLE_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      'RECONCILIATION_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      '',
    ].join('\n'),
  );
  writeJson(path.join(root, 'contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json'), {
    commitSha: 'a'.repeat(40),
    worktreeClean: true,
    network: { chainId: 84532 },
    contract: {
      address: escrow,
      deploymentTxHash: `0x${'b'.repeat(64)}`,
      deploymentBlock: 42152846,
      deploymentReceiptStatus: 1,
      deployerAddress: '0x9000000000000000000000000000000000000009',
      constructorArguments: {
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        oracleAddress: '0x1000000000000000000000000000000000000001',
        treasuryAddress: '0x2000000000000000000000000000000000000002',
        relayerAddress: '0x3000000000000000000000000000000000000003',
        admins: [
          '0x4000000000000000000000000000000000000004',
          '0x5000000000000000000000000000000000000005',
          '0x6000000000000000000000000000000000000006',
        ],
        requiredApprovals: 2,
      },
      roleAttestation: {
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        oracleAddress: '0x1000000000000000000000000000000000000001',
        treasuryAddress: '0x2000000000000000000000000000000000000002',
        treasuryPayoutAddress: '0x2000000000000000000000000000000000000002',
        relayerAllowed: true,
        admins: [
          '0x4000000000000000000000000000000000000004',
          '0x5000000000000000000000000000000000000005',
          '0x6000000000000000000000000000000000000006',
        ],
        requiredApprovals: 2,
        governanceEpoch: 1,
        oracleActive: true,
      },
    },
    verification: { requested: true, status: 'verified' },
    artifact: {
      compilerLongVersion: '0.8.34+commit.80d5c536',
      compilerSettings: { optimizer: { enabled: true, runs: 1 }, viaIR: true },
      compilerInputSha256: '1'.repeat(64),
      sourceSha256: { 'src/AgroasysEscrow.sol': '2'.repeat(64) },
      abiSha256: '3'.repeat(64),
      bytecodeSha256: '4'.repeat(64),
      localRuntimeBytecodeSha256: '5'.repeat(64),
      liveRuntimeBytecodeSha256: '5'.repeat(64),
      normalizedLocalRuntimeBytecodeSha256: '6'.repeat(64),
      normalizedRuntimeBytecodeSha256: '6'.repeat(64),
      runtimeBytecodeMatches: true,
    },
  });

  const report = buildStaticProtocolReport({
    rootDir: root,
    profile: 'runtime',
    mode: 'config-only',
    now: new Date('2026-05-30T00:00:00Z'),
  });

  assert.equal(report.status, 'pass');
  assert.equal(report.chain.chainId, 84532);
  assert.equal(report.contracts.escrowAddress, escrow);
  assert.equal(report.services.versions.gateway.version, '1.2.3');
  assert.equal(report.dashHandoff.sessionFileEnv, 'DASHBOARD_GATEWAY_SESSION_FILE');
});

test('candidate deployment validation rejects legacy evidence', () => {
  const result = validateCandidateDeployReport({
    commitSha: 'a'.repeat(40),
    network: { chainId: 84532 },
    contract: { address: '0x1000000000000000000000000000000000000001' },
    verification: { status: 'verified' },
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('deployment_block'));
  assert.ok(result.failures.includes('role_attestation'));
  assert.ok(result.failures.includes('artifact_provenance'));
});

test('buildStaticProtocolReport fails when live mode has no trusted session artifact', () => {
  const root = fixtureRepo();
  fs.writeFileSync(
    path.join(root, '.env.runtime'),
    [
      'STAGING_E2E_REAL_NETWORK_NAME=Base Sepolia',
      'STAGING_E2E_REAL_CHAIN_ID=84532',
      'GATEWAY_SETTLEMENT_RUNTIME=base-sepolia',
      'GATEWAY_ESCROW_ADDRESS=0xd2FB11ba1D95F1dF165b45Deb1B12c538fa920d4',
      '',
    ].join('\n'),
  );

  const report = buildStaticProtocolReport({
    rootDir: root,
    profile: 'runtime',
    mode: 'live',
  });

  assert.equal(report.status, 'fail');
  assert.equal(
    report.checks.find((check) => check.name === 'trusted_session_artifact_present').status,
    'fail',
  );
});
