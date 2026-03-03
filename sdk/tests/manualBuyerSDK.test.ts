/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { BuyerSDK } from '../src/modules/buyerSDK';
import type { Signer } from 'ethers';
import { AgroasysEscrow__factory } from '../src/types/typechain-types/factories/src/AgroasysEscrow__factory';
import { TradeStatus } from '../src/types/trade';
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
const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

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

function expectValidTxHash(txHash: string): void {
    expect(txHash).toMatch(TX_HASH_REGEX);
}

describeIntegration('BuyerSDK', () => {
    let buyerSDK: BuyerSDK;
    let buyerSigner: Signer;
    let escrowReadOnly: ReturnType<typeof AgroasysEscrow__factory.connect>;

    beforeAll(() => {
        assertRequiredEnv();
        buyerSDK = new BuyerSDK(TEST_CONFIG);
        buyerSigner = getBuyerSigner();
        const provider = buyerSigner.provider;
        if (!provider) {
            throw new Error('buyerSigner provider is unavailable');
        }
        escrowReadOnly = AgroasysEscrow__factory.connect(TEST_CONFIG.escrowAddress, provider);
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

        const buyerAddress = await buyerSigner.getAddress();
        const tradeCounterBefore = await escrowReadOnly.tradeCounter();
        const result = await buyerSDK.createTrade(tradeParams, buyerSigner);
        const tradeCounterAfter = await escrowReadOnly.tradeCounter();

        expectValidTxHash(result.txHash);
        expect(tradeCounterAfter).toBe(tradeCounterBefore + 1n);
        console.log(`Trade created: ${result.txHash}`);

        const createdTrade = await escrowReadOnly.trades(tradeCounterBefore);
        expect(createdTrade.buyerAddress.toLowerCase()).toBe(buyerAddress.toLowerCase());
        expect(createdTrade.supplierAddress.toLowerCase()).toBe(tradeParams.supplier.toLowerCase());
        expect(createdTrade.totalAmountLocked).toBe(tradeParams.totalAmount);
        expect(createdTrade.logisticsAmount).toBe(tradeParams.logisticsAmount);
        expect(createdTrade.platformFeesAmount).toBe(tradeParams.platformFeesAmount);
        expect(createdTrade.supplierFirstTranche).toBe(tradeParams.supplierFirstTranche);
        expect(createdTrade.supplierSecondTranche).toBe(tradeParams.supplierSecondTranche);
        expect(createdTrade.ricardianHash.toLowerCase()).toBe(tradeParams.ricardianHash.toLowerCase());
        expect(Number(createdTrade.status)).toBe(TradeStatus.LOCKED);
    });

    testBuyerDispute('should open dispute', async () => {
        const tradeId = requireManualBuyerE2EBigIntEnv('TEST_DISPUTE_TRADE_ID');

        const result = await buyerSDK.openDispute(tradeId, buyerSigner);
        expectValidTxHash(result.txHash);
        console.log(`Dispute opened: ${result.txHash}`);

        const tradeAfter = await escrowReadOnly.trades(tradeId);
        expect(Number(tradeAfter.status)).toBe(TradeStatus.FROZEN);
    });

    testBuyerTimeout('should cancel locked trade after timeout', async () => {
        const tradeId = requireManualBuyerE2EBigIntEnv('TEST_LOCKED_TRADE_ID');
        const buyerAddress = await buyerSigner.getAddress();
        const claimableBefore = await buyerSDK.getClaimableUsdc(buyerAddress);

        const result = await buyerSDK.cancelLockedTradeAfterTimeout(tradeId, buyerSigner);
        expectValidTxHash(result.txHash);
        console.log(`Locked trade cancelled: ${result.txHash}`);

        const tradeAfter = await escrowReadOnly.trades(tradeId);
        expect(Number(tradeAfter.status)).toBe(TradeStatus.CLOSED);
        const claimableAfter = await buyerSDK.getClaimableUsdc(buyerAddress);
        expect(claimableAfter).toBeGreaterThanOrEqual(claimableBefore);
    });

    testBuyerTimeout('should refund in-transit trade after timeout', async () => {
        const tradeId = requireManualBuyerE2EBigIntEnv('TEST_IN_TRANSIT_TRADE_ID');
        const buyerAddress = await buyerSigner.getAddress();
        const claimableBefore = await buyerSDK.getClaimableUsdc(buyerAddress);

        const result = await buyerSDK.refundInTransitAfterTimeout(tradeId, buyerSigner);
        expectValidTxHash(result.txHash);
        console.log(`In-transit trade refunded: ${result.txHash}`);

        const tradeAfter = await escrowReadOnly.trades(tradeId);
        expect(Number(tradeAfter.status)).toBe(TradeStatus.CLOSED);
        const claimableAfter = await buyerSDK.getClaimableUsdc(buyerAddress);
        expect(claimableAfter).toBeGreaterThanOrEqual(claimableBefore);
    });

    testBuyerClaim('should claim funds in the escrow', async () => {
        const result = await buyerSDK.claim(buyerSigner);
        expectValidTxHash(result.txHash);
        console.log(`Funds claimed: ${result.txHash}`);
    });
});
