/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  getBaseDeploymentTarget,
  loadBaseDeploymentConfig,
} from '../scripts/lib/baseDeploymentConfig';

describe('Base deployment config', function () {
  const validEnv = {
    DEPLOY_ORACLE_ADDRESS: '0x1111111111111111111111111111111111111111',
    DEPLOY_TREASURY_ADDRESS: '0x2222222222222222222222222222222222222222',
    DEPLOY_RELAYER_ADDRESS: '0x3333333333333333333333333333333333333333',
    DEPLOY_ADMINS:
      '0x4444444444444444444444444444444444444444,0x5555555555555555555555555555555555555555,0x6666666666666666666666666666666666666666',
    DEPLOY_REQUIRED_APPROVALS: '2',
    BASESCAN_API_KEY: 'test-only-key',
  };

  it('keeps the Hardhat and Foundry contract sources identical', function () {
    const hardhatSource = readFileSync(resolve(__dirname, '../src/AgroasysEscrow.sol'), 'utf8');
    const foundrySource = readFileSync(
      resolve(__dirname, '../foundry/src/AgroasysEscrow.sol'),
      'utf8',
    );

    expect(foundrySource).to.equal(hardhatSource);
  });

  it('returns the official Base deployment target metadata', async function () {
    const target = getBaseDeploymentTarget('base-sepolia');
    expect(target.chainId).to.equal(84532);
    expect(target.officialUsdcAddress).to.equal('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('loads a valid Base Sepolia deployment matrix', async function () {
    const config = loadBaseDeploymentConfig('base-sepolia', 84532, validEnv);

    expect(config.target.runtimeKey).to.equal('base-sepolia');
    expect(config.usdcAddress).to.equal('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(config.relayerAddress).to.equal('0x3333333333333333333333333333333333333333');
    expect(config.requiredApprovals).to.equal(2);
    expect(config.admins).to.have.length(3);
    expect(config.confirmations).to.equal(1);
    expect(isAbsolute(config.evidenceOutDir)).to.equal(true);
    expect(config.evidenceOutDir).to.equal(resolve(__dirname, '../reports/deploy/base-sepolia'));
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
    ).to.throw(/must contain more addresses than DEPLOY_REQUIRED_APPROVALS/);
  });

  it('rejects an admin set at parity with the approval threshold', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_REQUIRED_APPROVALS: '3',
      }),
    ).to.throw(/must contain more addresses than DEPLOY_REQUIRED_APPROVALS/);
  });

  it('rejects single-admin deployment matrices because governance requires two admins', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_ADMINS: '0x4444444444444444444444444444444444444444',
        DEPLOY_REQUIRED_APPROVALS: '1',
      }),
    ).to.throw(/must contain at least two admin addresses/);
  });

  it('rejects buyer or supplier wallets in deployment admin lists when provided', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_FORBIDDEN_USER_WALLETS:
          '0x4444444444444444444444444444444444444444,0x7777777777777777777777777777777777777777',
      }),
    ).to.throw(/must not include buyer\/supplier user wallet/);
  });

  it('rejects buyer or supplier wallets as deployment relayers when provided', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_RELAYER_ADDRESS: '0x7777777777777777777777777777777777777777',
        DEPLOY_FORBIDDEN_USER_WALLETS:
          '0x7777777777777777777777777777777777777777,0x8888888888888888888888888888888888888888',
      }),
    ).to.throw(/DEPLOY_RELAYER_ADDRESS must not be buyer\/supplier user wallet/);
  });

  it('rejects chain id mismatches for the selected Base network', async function () {
    expect(() => loadBaseDeploymentConfig('base-sepolia', 8453, validEnv)).to.throw(
      /requires chainId=84532, received 8453/,
    );
  });

  it('rejects runtime role overlap', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_RELAYER_ADDRESS: validEnv.DEPLOY_ORACLE_ADDRESS,
      }),
    ).to.throw(/must be distinct runtime identities/);
  });

  it('requires the approved three-admin, two-approval Base Sepolia matrix', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_ADMINS: `${validEnv.DEPLOY_ADMINS},0x9999999999999999999999999999999999999999`,
      }),
    ).to.throw(/requires exactly three admins and two approvals/);
  });

  it('does not allow explorer verification to be disabled', async function () {
    expect(() =>
      loadBaseDeploymentConfig('base-sepolia', 84532, {
        ...validEnv,
        DEPLOY_VERIFY: 'false',
      }),
    ).to.throw(/DEPLOY_VERIFY must remain true/);
  });

  it('requires an explorer API key before deployment', async function () {
    const { BASESCAN_API_KEY: _removed, ...withoutExplorerKey } = validEnv;
    expect(() => loadBaseDeploymentConfig('base-sepolia', 84532, withoutExplorerKey)).to.throw(
      /BASESCAN_API_KEY or ETHERSCAN_API_KEY is required/,
    );
  });

  it('preserves an explicit evidence output directory', async function () {
    const config = loadBaseDeploymentConfig('base-sepolia', 84532, {
      ...validEnv,
      DEPLOY_EVIDENCE_OUT_DIR: '/tmp/cotsel-deployment-evidence',
    });
    expect(config.evidenceOutDir).to.equal('/tmp/cotsel-deployment-evidence');
  });
});
