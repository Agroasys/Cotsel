import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { validateBaseSepoliaSelection } from '../validate-base-sepolia-staging-contract.mjs';

const manifest = JSON.parse(readFileSync('integration/base-sepolia-staging-contract.json', 'utf8'));
const deployment = JSON.parse(
  readFileSync('contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json', 'utf8'),
);

function requested(overrides = {}) {
  return {
    address: manifest.address,
    deploymentBlock: String(manifest.deploymentBlock),
    usdcAddress: manifest.usdcAddress,
    ...overrides,
  };
}

test('accepts only the independently accepted deployment evidence', () => {
  const result = validateBaseSepoliaSelection({ manifest, deployment, requested: requested() });
  assert.deepEqual(result, {
    address: manifest.address,
    deploymentBlock: manifest.deploymentBlock,
    chainId: 84532,
  });
});

test('rejects a historical runtime address or start block', () => {
  assert.throws(
    () =>
      validateBaseSepoliaSelection({
        manifest,
        deployment,
        requested: requested({
          address: '0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd',
          deploymentBlock: '45807259',
        }),
      }),
    /requested address does not match/,
  );
});

test('rejects a wrong start block or USDC independently', () => {
  assert.throws(
    () =>
      validateBaseSepoliaSelection({
        manifest,
        deployment,
        requested: requested({ deploymentBlock: '45807259' }),
      }),
    /requested deployment block does not match/,
  );
  assert.throws(
    () =>
      validateBaseSepoliaSelection({
        manifest,
        deployment,
        requested: requested({ usdcAddress: '0x0000000000000000000000000000000000000001' }),
      }),
    /requested USDC does not match/,
  );
});

test('rejects withdrawn acceptance or deployment evidence drift', () => {
  const unaccepted = structuredClone(manifest);
  unaccepted.acceptance.decision = 'PENDING';
  assert.throws(
    () =>
      validateBaseSepoliaSelection({ manifest: unaccepted, deployment, requested: requested() }),
    /acceptance decision does not match/,
  );

  const driftedDeployment = structuredClone(deployment);
  driftedDeployment.contract.deploymentReceiptStatus = 0;
  assert.throws(
    () =>
      validateBaseSepoliaSelection({
        manifest,
        deployment: driftedDeployment,
        requested: requested(),
      }),
    /deployment receipt status does not match/,
  );
});

test('rejects an acceptance record that does not identify the independent decision', () => {
  const wrongDecision = structuredClone(manifest);
  wrongDecision.acceptance.evidence = 'https://github.com/Agroasys/Cotsel/issues/639';
  assert.throws(
    () =>
      validateBaseSepoliaSelection({
        manifest: wrongDecision,
        deployment,
        requested: requested(),
      }),
    /acceptance evidence does not match/,
  );
});

test('rejects compiler, bytecode, and role drift', () => {
  for (const mutate of [
    (candidate) => {
      candidate.artifact.compilerSettings.optimizer.runs = 200;
    },
    (candidate) => {
      candidate.artifact.normalizedRuntimeBytecodeSha256 = '0'.repeat(64);
    },
    (candidate) => {
      candidate.contract.constructorArguments.oracleAddress =
        '0x0000000000000000000000000000000000000001';
    },
  ]) {
    const driftedDeployment = structuredClone(deployment);
    mutate(driftedDeployment);
    assert.throws(() =>
      validateBaseSepoliaSelection({
        manifest,
        deployment: driftedDeployment,
        requested: requested(),
      }),
    );
  }
});
