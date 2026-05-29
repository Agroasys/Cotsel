/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { BuyerSDK } from '../src/modules/buyerSDK';
import type { Signer } from 'ethers';
import {
  TEST_CONFIG,
  assertRequiredEnv,
  getBuyerSigner,
  generateTestRicardianHash,
  hasRequiredEnv,
  parseUSDC,
} from './setup';

const DEFAULT_SUPPLIER_ADDRESS = '0x4aF052cB4B3eC7b58322548021bF254Cc4c80b2c';
const SUPPLIER_ADDRESS = process.env.SUPPLIER_ADDRESS ?? DEFAULT_SUPPLIER_ADDRESS;
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

  test('should get buyer nonce', async () => {
    const buyerAddress = await buyerSigner.getAddress();
    const nonce1 = await buyerSDK.getBuyerNonce(buyerAddress);
    const nonce2 = await buyerSDK.getBuyerNonce(buyerAddress);

    expect(typeof nonce1).toBe('bigint');
    expect(typeof nonce2).toBe('bigint');
    expect(nonce1).toBeGreaterThanOrEqual(0n);
    expect(nonce2).toBeGreaterThanOrEqual(0n);
    // When no transactions are sent between calls, the nonce should remain stable.
    expect(nonce2).toBe(nonce1);

    console.log(`Buyer nonce (first call): ${nonce1}`);
    console.log(`Buyer nonce (second call): ${nonce2}`);
  });

  test('should check USDC balance and allowance', async () => {
    const buyerAddress = await buyerSigner.getAddress();

    const balance = await buyerSDK.getUSDCBalance(buyerAddress);
    const allowance = await buyerSDK.getUSDCAllowance(buyerAddress);

    expect(typeof balance).toBe('bigint');
    expect(typeof allowance).toBe('bigint');
    expect(balance).toBeGreaterThanOrEqual(0n);
    expect(allowance).toBeGreaterThanOrEqual(0n);

    console.log(`USDC balance: ${balance}`);
    console.log(`USDC allowance: ${allowance}`);
  });

  test('should reject direct buyer-paid trade creation', async () => {
    const tradeParams = {
      supplier: SUPPLIER_ADDRESS,
      totalAmount: parseUSDC('10000'),
      logisticsAmount: parseUSDC('1000'),
      platformFeesAmount: parseUSDC('500'),
      supplierFirstTranche: parseUSDC('4000'),
      supplierSecondTranche: parseUSDC('4500'),
      ricardianHash: generateTestRicardianHash('test1'),
    };

    await expect(buyerSDK.createTrade(tradeParams, buyerSigner)).rejects.toThrow(
      'Direct buyer-paid createTrade was removed',
    );
  });

  test('should fail to create a trade with invalid supplier address', async () => {
    const invalidTradeParams = {
      supplier: '0xINVALID_SUPPLIER_ADDRESS',
      totalAmount: parseUSDC('10000'),
      logisticsAmount: parseUSDC('1000'),
      platformFeesAmount: parseUSDC('500'),
      supplierFirstTranche: parseUSDC('4000'),
      supplierSecondTranche: parseUSDC('4500'),
      ricardianHash: generateTestRicardianHash('invalid-supplier-test'),
    };
    await expect(buyerSDK.createTrade(invalidTradeParams, buyerSigner)).rejects.toThrow();
  });

  test('should reject direct buyer-paid dispute opening', async () => {
    await expect(buyerSDK.openDispute(1n, buyerSigner)).rejects.toThrow(
      'Direct buyer-paid openDispute was removed',
    );
  });

  test('should reject direct buyer-paid locked timeout cancellation', async () => {
    await expect(buyerSDK.cancelLockedTradeAfterTimeout(1n, buyerSigner)).rejects.toThrow(
      'Direct buyer-paid cancelLockedTradeAfterTimeout was removed',
    );
  });

  test('should reject direct buyer-paid in-transit timeout refund', async () => {
    await expect(buyerSDK.refundInTransitAfterTimeout(1n, buyerSigner)).rejects.toThrow(
      'Direct buyer-paid refundInTransitAfterTimeout was removed',
    );
  });
});
