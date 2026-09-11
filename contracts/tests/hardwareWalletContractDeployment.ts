// SPDX-License-Identifier: Apache-2.0
import { expect } from 'chai';
import {
  assertHardwareWalletDeploymentTransaction,
  loadDeploymentTransactionHash,
  loadHardwareWalletDeployerConfig,
} from '../scripts/lib/hardwareWalletContractDeployment';

describe('hardware-wallet contract deployment', function () {
  const deployer = '0x1111111111111111111111111111111111111111';
  const expectedData = '0x60006000';

  it('requires an independently reviewed deployment address', function () {
    expect(() => loadHardwareWalletDeployerConfig({})).to.throw('DEPLOYER_ADDRESS is required');
    expect(() => loadHardwareWalletDeployerConfig({ DEPLOYER_ADDRESS: 'not-an-address' })).to.throw(
      'DEPLOYER_ADDRESS must be a valid EVM address',
    );
  });

  it('rejects raw private keys on the hardware-wallet path', function () {
    expect(() =>
      loadHardwareWalletDeployerConfig({
        DEPLOYER_ADDRESS: deployer,
        PRIVATE_KEY: 'test-only-placeholder',
      }),
    ).to.throw('PRIVATE_KEY and PRIVATE_KEY2 must not be configured');
  });

  it('requires a transaction hash before final verification', function () {
    expect(() => loadDeploymentTransactionHash({})).to.throw('DEPLOY_TRANSACTION_HASH is required');
    expect(() => loadDeploymentTransactionHash({ DEPLOY_TRANSACTION_HASH: '0x1234' })).to.throw(
      'must be a 32-byte transaction hash',
    );
  });

  it('accepts the exact reviewed contract-creation transaction', function () {
    expect(() =>
      assertHardwareWalletDeploymentTransaction({
        expectedDeployer: deployer,
        expectedData,
        from: deployer,
        to: null,
        data: expectedData,
        value: 0n,
      }),
    ).not.to.throw();
  });

  it('rejects the wrong signer', function () {
    expect(() =>
      assertHardwareWalletDeploymentTransaction({
        expectedDeployer: deployer,
        expectedData,
        from: '0x2222222222222222222222222222222222222222',
        to: null,
        data: expectedData,
        value: 0n,
      }),
    ).to.throw('signer does not match DEPLOYER_ADDRESS');
  });

  it('rejects calls, value transfers, and changed constructor data', function () {
    expect(() =>
      assertHardwareWalletDeploymentTransaction({
        expectedDeployer: deployer,
        expectedData,
        from: deployer,
        to: '0x2222222222222222222222222222222222222222',
        data: expectedData,
        value: 0n,
      }),
    ).to.throw('must be a contract-creation transaction');

    expect(() =>
      assertHardwareWalletDeploymentTransaction({
        expectedDeployer: deployer,
        expectedData,
        from: deployer,
        to: null,
        data: expectedData,
        value: 1n,
      }),
    ).to.throw('must not transfer native value');

    expect(() =>
      assertHardwareWalletDeploymentTransaction({
        expectedDeployer: deployer,
        expectedData,
        from: deployer,
        to: null,
        data: '0x60016000',
        value: 0n,
      }),
    ).to.throw('does not match the reviewed constructor request');
  });
});
