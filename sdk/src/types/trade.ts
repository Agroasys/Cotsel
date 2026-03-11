/**
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical buyer lock payload for external checkout UIs.
 *
 * This is the authoritative payload contract for `BuyerSDK.createTrade(...)`.
 * External checkout integrations MUST construct this object to initiate the
 * escrow lock flow. The SDK validates every field before signing or submitting
 * any transaction.
 *
 * ## Amount invariant
 * The following equality MUST hold and is enforced at runtime by
 * `validateBuyerLockPayload`:
 *
 * ```
 * totalAmount === logisticsAmount + platformFeesAmount
 *              + supplierFirstTranche + supplierSecondTranche
 * ```
 *
 * All amount fields are denominated in the **smallest unit** of the payment
 * token. For USDC (6 decimals) 1 USDC = 1_000_000n.
 *
 * ## Nonce
 * The nonce is **not** a caller-supplied field. The SDK derives the current
 * on-chain nonce via `BuyerSDK.getBuyerNonce(buyerAddress)` immediately before
 * constructing the EIP-191 signature. Checkout UIs MUST NOT pass a nonce.
 *
 * ## Deadline
 * An optional timestamp. Transactions submitted
 * after this timestamp are rejected by the contract. When omitted the SDK
 * defaults to `Math.floor(Date.now() / 1000) + 3600` (one hour from now).
 * Checkout UIs MAY supply an explicit deadline for tighter expiry control.
 *
 * ## Ricardian hash linkage
 * The `ricardianHash` field anchors the on-chain escrow to a specific version
 * of the off-chain legal trade agreement. It is immutable after `createTrade`
 * and is used by auditors and courts to verify the settlement against the exact
 * document hash. The hash MUST be produced by the Ricardian service before the
 * checkout UI calls `createTrade`.
 */
export interface BuyerLockPayload {
    /**
     * EVM address of the supplier (goods/service provider).
     *
     * Required. Must be a valid non-zero EVM address.
     */
    supplier: string;

    /**
     * Total USDC amount to lock in escrow, in the smallest USDC unit (6 decimals).
     *
     * Required. Must be positive and MUST satisfy the amount invariant:
     * `totalAmount === logisticsAmount + platformFeesAmount + supplierFirstTranche + supplierSecondTranche`
     *
     * This is the amount the buyer wallet approves and the escrow contract
     * pulls atomically during `createTrade`.
     */
    totalAmount: bigint;

    /**
     * Logistics fee component, in the smallest USDC unit.
     *
     * Routed to the `TreasuryWallet` during Stage 1.
     */
    logisticsAmount: bigint;

    /**
     * Platform service fee component, in the smallest USDC unit.
     *
     * Routed to the `TreasuryWallet` during Stage 1.
     */
    platformFeesAmount: bigint;

    /**
     * First supplier tranche, released at Stage 1.
     */
    supplierFirstTranche: bigint;

    /**
     * Second supplier tranche, released at Stage 2 (arrival / inspection
     * attestation).
     */
    supplierSecondTranche: bigint;

    /**
     * SHA-256 hash of the off-chain Ricardian contract (the legal trade
     * agreement), encoded as a `0x`-prefixed 32-byte hex string (66 chars).
     *
     * This value is immutable after `createTrade` and serves as the on-chain
     * anchor linking settlement state to the exact legal document version.
     * External checkout UIs MUST obtain this hash from the Ricardian service
     * **before** calling `createTrade` — it cannot be back-filled later.
     */
    ricardianHash: string;

    /**
     * Optional UNIX timestamp (seconds since epoch) after which the lock
     * signature is considered expired and the contract will reject the call.
     *
     * When omitted the SDK defaults to `Math.floor(Date.now() / 1000) + 3600`
     * (one hour from now). Checkout UIs MAY supply an explicit value for
     * tighter session-scoped expiry control.
     */
    deadline?: number;
}

export interface TradeResult {
    txHash: string;
    blockNumber: number;
}

export enum TradeStatus {
    LOCKED = 0,
    IN_TRANSIT = 1,
    ARRIVAL_CONFIRMED = 2,
    FROZEN = 3,
    CLOSED = 4
}

export interface Trade {
    tradeId: string;
    buyer: string;
    supplier: string;
    status: TradeStatus;
    totalAmountLocked: bigint;
    logisticsAmount: bigint;
    platformFeesAmount: bigint;
    supplierFirstTranche: bigint;
    supplierSecondTranche: bigint;
    ricardianHash: string;
    createdAt: Date;
    arrivalTimestamp?: Date;
}