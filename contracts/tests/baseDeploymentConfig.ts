/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import {
  getBaseDeploymentTarget,
  loadBaseDeploymentConfig,
} from '../scripts/lib/baseDeploymentConfig';

describe('Base deployment config', function () {
  const validEnv = {
    DEPLOY_ORACLE_ADDRESS: '0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D',
    DEPLOY_TREASURY_ADDRESS: '0x229C75F0cD13D6ab7621403Bd951a9e43ba53b1e',
    DEPLOY_ADMINS:
      '0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D,0x229C75F0cD13D6ab7621403Bd951a9e43ba53b1e,0x4aF052cB4B3eC7b58322548021bF254Cc4c80b2c',
    DEPLOY_REQUIRED_APPROVALS: '2',
  };

  it('returns the official Base deployment target metadata', async function () {
    const target = getBaseDeploymentTarget('base-sepolia');
    expect(target.chainId).to.equal(84532);
    expect(target.officialUsdcAddress).to.equal('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('loads a valid Base Sepolia deployment matrix', async function () {
    const config = loadBaseDeploymentConfig('base-sepolia', 84532, validEnv);

    expect(config.target.runtimeKey).to.equal('base-sepolia');
    expect(config.usdcAddress).to.equal('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(config.requiredApprovals).to.equal(2);
    expect(config.admins).to.have.length(3);
    expect(config.confirmations).to.equal(1);
  });

  it('rejects unofficial USDC addresses for Base runtime deployments', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-mainnet', 8453, {
        ...validEnv,
        DEPLOY_USDC_ADDRESS: '0x0000000000000000000000000000000000000001',
      }),
    ).to.throw(/must match the official Base Mainnet USDC address/);
  });

  it('rejects approval thresholds larger than the admin quorum', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_REQUIRED_APPROVALS: '4',
      }),
    ).to.throw(/must not exceed the number of admin addresses/);
  });

  it('rejects chain id mismatches for the selected Base network', async function () {
    expect(() => loadBaseDeploymentConfig('base-sepolia', 8453, validEnv)).to.throw(
      /requires chainId=84532, received 8453/,
    );
  });
});
