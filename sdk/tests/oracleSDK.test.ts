/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { OracleSDK } from '../src/modules/oracleSDK';
import type { ethers } from 'ethers';
import { TEST_CONFIG, assertRequiredEnv, getOracleSigner, hasRequiredEnv } from './setup';

const describeIntegration = hasRequiredEnv ? describe : describe.skip;

describeIntegration('OracleSDK', () => {
  let oracleSDK: OracleSDK;
  let oracleSigner: ethers.Signer;

  beforeAll(() => {
    assertRequiredEnv();
    oracleSDK = new OracleSDK(TEST_CONFIG);
    oracleSigner = getOracleSigner();
  });

  test('should get oracle address', async () => {
    const oracleAddress = await oracleSDK.getOracleAddress();
    console.log(`oracle address: ${oracleAddress}`);
  });

  test.skip('should release stage 1 funds', async () => {
    const tradeId = 2n; // replace

    const txHash = await oracleSDK.releaseFundsStage1(tradeId, oracleSigner);

    console.log(`stage 1 released: ${txHash.txHash}`);
  });

  test.skip('should confirm arrival', async () => {
    const tradeId = 2n; // replace

    const txHash = await oracleSDK.confirmArrival(tradeId, oracleSigner);

    expect(txHash.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    console.log(`arrival confirmed: ${txHash.txHash}`);
  });

  test.skip('should finalize after dispute window', async () => {
    const tradeId = 2n; // replace

    const txHash = await oracleSDK.finalizeAfterDisputeWindow(tradeId, oracleSigner);

    expect(txHash.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    console.log(`trade finalized: ${txHash.txHash}`);
  });
});
