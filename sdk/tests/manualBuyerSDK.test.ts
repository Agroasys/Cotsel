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
    parseUSDC
} from './setup';

const SUPPLIER_ADDRESS =
    process.env.SUPPLIER_ADDRESS ?? '0x4aF052cB4B3eC7b58322548021bF254Cc4c80b2c';
const runManualE2E = process.env.RUN_E2E === 'true';
const runBuyerClaimE2E = process.env.RUN_BUYER_CLAIM_E2E === 'true';
const runBuyerDisputeE2E = process.env.RUN_BUYER_DISPUTE_E2E === 'true';
const runBuyerTimeoutE2E = process.env.RUN_BUYER_TIMEOUT_E2E === 'true';
const describeIntegration = runManualE2E && hasRequiredEnv ? describe : describe.skip;
const testBuyerClaim = runManualE2E && hasRequiredEnv && runBuyerClaimE2E ? test : test.skip;
const testBuyerDispute = runManualE2E && hasRequiredEnv && runBuyerDisputeE2E ? test : test.skip;
const testBuyerTimeout = runManualE2E && hasRequiredEnv && runBuyerTimeoutE2E ? test : test.skip;

function getOptionalEnv(name: string): string | undefined {
    const value = process.env[name];
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function requireManualBuyerE2EEnv(name: string): string {
    const value = getOptionalEnv(name);
    if (!value) {
        throw new Error(`Missing required manual buyer E2E environment variable: ${name}`);
    }
    return value;
}

function requireManualBuyerE2EBigIntEnv(name: string): bigint {
    const value = requireManualBuyerE2EEnv(name);
    try {
        return BigInt(value);
    } catch {
        throw new Error(`Invalid bigint in manual buyer E2E environment variable ${name}: ${value}`);
    }
}

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
        const nonce = await buyerSDK.getBuyerNonce(buyerAddress);
        
        expect(typeof nonce).toBe('bigint');
        expect(nonce).toBeGreaterThanOrEqual(0n);
        
        console.log(`buyer nonce: ${nonce}`);
    });
    
    test('should check USDC balance and allowance', async () => {
        const buyerAddress = await buyerSigner.getAddress();
        
        const balance = await buyerSDK.getUSDCBalance(buyerAddress);
        const allowance = await buyerSDK.getUSDCAllowance(buyerAddress);
        
        expect(typeof balance).toBe('bigint');
        expect(typeof allowance).toBe('bigint');
        
        console.log(`USDC balance: ${balance}`);
        console.log(`USDC allowance: ${allowance}`);
    });

    test('should create a trade', async () => {
        const tradeParams = {
            supplier: SUPPLIER_ADDRESS,
            totalAmount: parseUSDC('10000'),
            logisticsAmount: parseUSDC('1000'),
            platformFeesAmount: parseUSDC('500'),
            supplierFirstTranche: parseUSDC('4000'),
            supplierSecondTranche: parseUSDC('4500'),
            ricardianHash: generateTestRicardianHash('test1')
        };

        const result = await buyerSDK.createTrade(tradeParams, buyerSigner);
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        console.log(`Trade created: ${result.txHash}`);
    });

    testBuyerDispute('should open dispute', async () => {
        const tradeId = requireManualBuyerE2EBigIntEnv('TEST_DISPUTE_TRADE_ID');

        const result = await buyerSDK.openDispute(tradeId, buyerSigner);
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        console.log(`Dispute opened: ${result.txHash}`);
    });

    testBuyerTimeout('should cancel locked trade after timeout', async () => {
        const tradeId = requireManualBuyerE2EBigIntEnv('TEST_LOCKED_TRADE_ID');

        const result = await buyerSDK.cancelLockedTradeAfterTimeout(tradeId, buyerSigner);
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        console.log(`Locked trade cancelled: ${result.txHash}`);
    });

    testBuyerTimeout('should refund in-transit trade after timeout', async () => {
        const tradeId = requireManualBuyerE2EBigIntEnv('TEST_IN_TRANSIT_TRADE_ID');

        const result = await buyerSDK.refundInTransitAfterTimeout(tradeId, buyerSigner);
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        console.log(`In-transit trade refunded: ${result.txHash}`);
    });

    testBuyerClaim('should claim funds in the escrow', async () => {
        const result = await buyerSDK.claim(buyerSigner);
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        console.log(`Funds claimed: ${result.txHash}`);
    });
});
