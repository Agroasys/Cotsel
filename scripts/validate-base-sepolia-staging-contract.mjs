#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value;
}

function requireAddress(value, label) {
  const address = requireString(value, label);
  if (!ADDRESS_PATTERN.test(address)) fail(`${label} must be an EVM address`);
  return address.toLowerCase();
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match the accepted contract selection`);
}

function requireSha256(value, label) {
  const hash = requireString(value, label);
  if (!SHA256_PATTERN.test(hash)) fail(`${label} must be a SHA-256 digest`);
  return hash;
}

function normalizedAddresses(values, label) {
  if (!Array.isArray(values) || values.length === 0) fail(`${label} must be a non-empty array`);
  return values.map((value, index) => requireAddress(value, `${label}[${index}]`));
}

export function validateBaseSepoliaSelection({ manifest, deployment, requested }) {
  requireEqual(manifest.schemaVersion, 'cotsel.base-sepolia-staging-contract.v1', 'schemaVersion');
  requireEqual(manifest.status, 'accepted-for-staging-promotion', 'status');
  requireEqual(manifest.environment, 'aws-staging', 'environment');
  requireEqual(manifest.chainId, 84532, 'chainId');
  requireEqual(manifest.acceptance?.decision, 'ACCEPTED', 'acceptance decision');
  requireEqual(
    manifest.acceptance?.issue,
    'https://github.com/Agroasys/Cotsel/issues/639',
    'acceptance issue',
  );
  requireEqual(manifest.acceptance?.acceptedBy, 'czpyioe', 'acceptance actor');
  requireEqual(manifest.acceptance?.acceptedAt, '2026-08-26T14:26:59Z', 'acceptance timestamp');
  requireEqual(
    manifest.acceptance?.evidence,
    'https://github.com/Agroasys/Cotsel/issues/639#issuecomment-5426793276',
    'acceptance evidence',
  );

  const address = requireAddress(manifest.address, 'address');
  const usdcAddress = requireAddress(manifest.usdcAddress, 'usdcAddress');
  const deploymentBlock = requirePositiveInteger(manifest.deploymentBlock, 'deploymentBlock');
  if (!HASH_PATTERN.test(manifest.deploymentTransactionHash ?? '')) {
    fail('deploymentTransactionHash must be a transaction hash');
  }
  if (!COMMIT_PATTERN.test(manifest.sourceCommit ?? '')) {
    fail('sourceCommit must be a full Git commit');
  }

  const artifact = manifest.artifact ?? {};
  requireEqual(
    deployment.artifact?.compilerLongVersion,
    artifact.compilerVersion,
    'compiler version',
  );
  requireEqual(
    deployment.artifact?.compilerSettings?.viaIR,
    artifact.compilerSettings?.viaIR,
    'viaIR',
  );
  requireEqual(
    deployment.artifact?.compilerSettings?.optimizer?.enabled,
    artifact.compilerSettings?.optimizerEnabled,
    'optimizer enabled',
  );
  requireEqual(
    deployment.artifact?.compilerSettings?.optimizer?.runs,
    artifact.compilerSettings?.optimizerRuns,
    'optimizer runs',
  );
  requireEqual(
    deployment.artifact?.compilerSettings?.evmVersion,
    artifact.compilerSettings?.evmVersion,
    'EVM version',
  );
  requireEqual(
    requireSha256(deployment.artifact?.compilerInputSha256, 'deployment compiler input'),
    requireSha256(artifact.compilerInputSha256, 'artifact.compilerInputSha256'),
    'compiler input',
  );
  requireEqual(
    requireSha256(deployment.artifact?.abiSha256, 'deployment ABI'),
    requireSha256(artifact.abiSha256, 'artifact.abiSha256'),
    'ABI',
  );
  requireEqual(
    requireSha256(deployment.artifact?.bytecodeSha256, 'deployment creation bytecode'),
    requireSha256(artifact.creationBytecodeSha256, 'artifact.creationBytecodeSha256'),
    'creation bytecode',
  );
  requireEqual(
    requireSha256(
      deployment.artifact?.normalizedRuntimeBytecodeSha256,
      'deployment runtime bytecode',
    ),
    requireSha256(
      artifact.normalizedRuntimeBytecodeSha256,
      'artifact.normalizedRuntimeBytecodeSha256',
    ),
    'normalized runtime bytecode',
  );
  requireEqual(deployment.artifact?.runtimeBytecodeMatches, true, 'runtime bytecode match');

  requireEqual(deployment.network?.chainId, manifest.chainId, 'deployment chainId');
  requireEqual(deployment.worktreeClean, true, 'deployment worktreeClean');
  requireEqual(deployment.verification?.requested, true, 'explorer verification request');
  requireEqual(deployment.verification?.status, 'verified', 'explorer verification status');
  requireEqual(deployment.commitSha, manifest.sourceCommit, 'deployment source commit');
  requireEqual(
    requireAddress(deployment.contract?.address, 'deployment address'),
    address,
    'deployment address',
  );
  requireEqual(deployment.contract?.deploymentBlock, deploymentBlock, 'deployment block');
  requireEqual(deployment.contract?.deploymentReceiptStatus, 1, 'deployment receipt status');
  requireEqual(
    deployment.contract?.deploymentTxHash?.toLowerCase(),
    manifest.deploymentTransactionHash.toLowerCase(),
    'deployment transaction',
  );
  requireEqual(
    requireAddress(deployment.contract?.constructorArguments?.usdcAddress, 'deployment USDC'),
    usdcAddress,
    'deployment USDC',
  );

  const roles = manifest.roles ?? {};
  for (const [manifestName, reportName] of [
    ['oracle', 'oracleAddress'],
    ['treasury', 'treasuryAddress'],
    ['relayer', 'relayerAddress'],
  ]) {
    const expected = requireAddress(roles[manifestName], `roles.${manifestName}`);
    requireEqual(
      requireAddress(
        deployment.contract?.constructorArguments?.[reportName],
        `deployment ${manifestName}`,
      ),
      expected,
      `deployment ${manifestName}`,
    );
  }
  requireEqual(
    requireAddress(deployment.contract?.roleAttestation?.treasuryPayoutAddress, 'treasury payout'),
    requireAddress(roles.treasuryPayout, 'roles.treasuryPayout'),
    'treasury payout',
  );
  requireEqual(
    JSON.stringify(
      normalizedAddresses(deployment.contract?.constructorArguments?.admins, 'deployment admins'),
    ),
    JSON.stringify(normalizedAddresses(roles.admins, 'roles.admins')),
    'deployment admins',
  );
  requireEqual(
    deployment.contract?.constructorArguments?.requiredApprovals,
    roles.requiredApprovals,
    'required approvals',
  );
  requireEqual(
    deployment.contract?.roleAttestation?.governanceEpoch,
    roles.governanceEpoch,
    'governance epoch',
  );
  requireEqual(
    requireAddress(deployment.contract?.roleAttestation?.oracleAddress, 'attested oracle'),
    requireAddress(roles.oracle, 'roles.oracle'),
    'attested oracle',
  );
  requireEqual(
    requireAddress(deployment.contract?.roleAttestation?.treasuryAddress, 'attested treasury'),
    requireAddress(roles.treasury, 'roles.treasury'),
    'attested treasury',
  );
  requireEqual(
    JSON.stringify(
      normalizedAddresses(deployment.contract?.roleAttestation?.admins, 'attested admins'),
    ),
    JSON.stringify(normalizedAddresses(roles.admins, 'roles.admins')),
    'attested admins',
  );
  requireEqual(
    deployment.contract?.roleAttestation?.requiredApprovals,
    roles.requiredApprovals,
    'attested required approvals',
  );
  requireEqual(
    deployment.contract?.roleAttestation?.oracleActive,
    roles.oracleActive,
    'oracle active status',
  );
  requireEqual(
    deployment.contract?.roleAttestation?.relayerAllowed,
    roles.relayerAllowed,
    'relayer allowlist status',
  );

  requireEqual(
    requireAddress(requested.address, 'requested address'),
    address,
    'requested address',
  );
  requireEqual(
    requirePositiveInteger(Number(requested.deploymentBlock), 'requested deployment block'),
    deploymentBlock,
    'requested deployment block',
  );
  requireEqual(
    requireAddress(requested.usdcAddress, 'requested USDC'),
    usdcAddress,
    'requested USDC',
  );

  return { address: manifest.address, deploymentBlock, chainId: manifest.chainId };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined)
      fail(`invalid argument ${name ?? ''}`.trim());
    options[name.slice(2)] = value;
  }
  return options;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const manifestPath = path.resolve(requireString(options.manifest, '--manifest'));
  const deploymentPath = path.resolve(requireString(options.deployment, '--deployment'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  requireEqual(
    deploymentPath,
    path.resolve(requireString(manifest.deploymentEvidence, 'deploymentEvidence')),
    'deployment evidence path',
  );
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
  const result = validateBaseSepoliaSelection({
    manifest,
    deployment,
    requested: {
      address: options.address,
      deploymentBlock: options['start-block'],
      usdcAddress: options.usdc,
    },
  });
  process.stdout.write(
    `accepted Base Sepolia selection verified: chain=${result.chainId} address=${result.address} block=${result.deploymentBlock}\n`,
  );
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`Base Sepolia selection rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}
