/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { BuyerSDK } from '../src/modules/buyerSDK';
import type { Signer } from 'ethers';
import { TEST_CONFIG, assertRequiredEnv, getBuyerSigner, hasRequiredEnv } from './setup';

const runManualE2E = process.env.RUN_E2E === 'true';
const describeIntegration = runManualE2E && hasRequiredEnv ? describe : describe.skip;

describeIntegration('BuyerSDK', () => {
  let buyerSDK: BuyerSDK;
  let buyerSigner: Signer;

  beforeAll(() => {
    assertRequiredEnv();
    buyerSDK = new BuyerSDK(TEST_CONFIG);
    buyerSigner = getBuyerSigner();
  });

  test('should get authorization nonce', async () => {
    const buyerAddress = await buyerSigner.getAddress();
    const nonce1 = await buyerSDK.getAuthorizationNonce(buyerAddress);
    const nonce2 = await buyerSDK.getAuthorizationNonce(buyerAddress);

    expect(typeof nonce1).toBe('bigint');
    expect(typeof nonce2).toBe('bigint');
    expect(nonce1).toBeGreaterThanOrEqual(0n);
    expect(nonce2).toBeGreaterThanOrEqual(0n);
    // When no transactions are sent between calls, the nonce should remain stable.
    expect(nonce2).toBe(nonce1);

    console.log(`Authorization nonce (first call): ${nonce1}`);
    console.log(`Authorization nonce (second call): ${nonce2}`);
  });

  test('should check USDC balance', async () => {
    const buyerAddress = await buyerSigner.getAddress();

    const balance = await buyerSDK.getUSDCBalance(buyerAddress);

    expect(typeof balance).toBe('bigint');
    expect(balance).toBeGreaterThanOrEqual(0n);

    console.log(`USDC balance: ${balance}`);
  });
});
