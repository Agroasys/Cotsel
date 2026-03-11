# Buyer Lock Payload — Checkout UI Integration Guide

This document is the reference for external checkout UIs that
integrate with `BuyerSDK.createTrade(...)`.

**Relevant SDK type:** `TradeParameters` (`sdk/src/types/trade.ts`)  
**Entry point method:** `BuyerSDK.createTrade(payload, buyerSigner)`


## Overview

When a buyer initiates settlement on the Agroasys platform, the checkout UI
must assemble a `TradeParameters` and pass it to `BuyerSDK.createTrade(...)`.
The SDK validates the payload, handles the USDC approval if needed, derives the
nonce, constructs the EIP-191 signature, and submits the lock transaction.

The checkout UI is responsible for:

1. Obtaining the `ricardianHash` from the Ricardian service **before** calling
   `createTrade`.
2. Decomposing the trade value into its four canonical amount components.
3. Providing the supplier's wallet address.
4. Optionally setting a `deadline`.


## Canonical Payload Shape

```ts
import { TradeParameters } from '@agroasys/sdk';

const payload: TradeParameters = {
  supplier:             '0xSupplierAddress...',
  totalAmount:          141_500_000n,   // 141.50 USDC (6 decimals)
  logisticsAmount:       10_000_000n,   //  10.00 USDC — logistics fee
  platformFeesAmount:     1_500_000n,   //   1.50 USDC — platform fee
  supplierFirstTranche:  52_000_000n,   //  52.00 USDC — 40% of net (Stage 1)
  supplierSecondTranche: 78_000_000n,   //  78.00 USDC — 60% of net (Stage 2)
  ricardianHash: '0x3a4b5c6d...f1e2d3', // 32-byte SHA-256 of legal contract
  // deadline is optional; SDK defaults to now + 3600 s when omitted
};
```


## Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `supplier` | `string` | Yes | EVM address of the supplier. Must be non-zero. |
| `totalAmount` | `bigint` | Yes | Total USDC amount the buyer locks. Must equal the sum of the four component fields. |
| `logisticsAmount` | `bigint` | Yes | Logistics fee. Routed to `TreasuryWallet` at Stage 1. |
| `platformFeesAmount` | `bigint` | Yes | Platform service fee. Routed to `TreasuryWallet` at Stage 1. |
| `supplierFirstTranche` | `bigint` | Yes | First supplier payment, released at Stage 1 (ship-out). Protocol default: 40% of net. Must be > 0. |
| `supplierSecondTranche` | `bigint` | Yes | Second supplier payment, released at Stage 2 (arrival). Protocol default: 60% of net. Must be > 0. |
| `ricardianHash` | `string` | Yes | `0x`-prefixed 32-byte hex SHA-256 of the off-chain legal contract. Immutable after lock. |
| `deadline` | `number` | No | UNIX timestamp (seconds) after which the signature expires. SDK default: `now + 3600`. |

> All `bigint` amounts are in the **smallest unit** of USDC (6 decimals).
> 1 USDC = `1_000_000n`.



## Amount Invariant

The following equality **must** hold. The SDK enforces it at runtime and throws
`ValidationError` if violated:

```
totalAmount === logisticsAmount
             + platformFeesAmount
             + supplierFirstTranche
             + supplierSecondTranche
```


**Checkout UI responsibility:**

Call the Ricardian service to anchor the legal document and receive the hash **before** assembling the `TradeParameters`.


## Nonce and Deadline

### Nonce

The nonce is **not** part of `TradeParameters`. The SDK derives the current
per-buyer on-chain nonce automatically:

```ts
const nonce = await this.getBuyerNonce(buyerAddress);
```

Checkout UIs MUST NOT pass a nonce.

### Deadline

`deadline` is optional. When omitted, the SDK defaults to:

```ts
const deadline = payload.deadline ?? Math.floor(Date.now() / 1000) + 3600;
```


## USDC Approval

The SDK checks the buyer's current USDC allowance for the escrow contract
before signing. If `allowance < totalAmount`, it automatically issues an
`approve` transaction:

```ts
await usdcContract.approve(escrowAddress, payload.totalAmount);
```

Checkout UIs do **not** need to call `approveUSDC` separately; `createTrade`
handles this transparently.