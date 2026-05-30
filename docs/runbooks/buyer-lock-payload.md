# Buyer Lock Payload — Checkout UI Integration Guide

This document is the reference for external checkout UIs that integrate with
the gasless create-trade flow.

**Relevant SDK type:** `BuyerLockPayload` (`sdk/src/types/trade.ts`)
**Backward-compatible alias:** `TradeParameters`
**Primary entry point method:** `BuyerSDK.createGaslessTradeExecutionRequest(payload, buyerSigner, input)`

## Overview

When a buyer initiates settlement on the Agroasys platform, the checkout UI
must assemble a `BuyerLockPayload` and pass it to
`BuyerSDK.createGaslessTradeExecutionRequest(...)`. The SDK validates the
payload, derives the on-chain authorization nonce, asks the buyer to sign an
EIP-712 escrow authorization, asks the buyer to sign the USDC
receive-with-authorization payload, and returns a gateway-ready gasless
execution request. A backend relayer submits the create-trade request so the
buyer does not need native gas.

The checkout UI is responsible for:

1. Obtaining the `ricardianHash` from the Ricardian service **before**
   requesting the gasless create-trade authorization.
2. Decomposing the trade value into its four canonical amount components.
3. Providing the supplier's wallet address.
4. Providing the Cotsel settlement `handoffId`.
5. Setting a short `expiresAt` timestamp for the gasless execution request.
6. Optionally setting a signature `deadline`.

## Canonical Payload Shape

```ts
import { BuyerLockPayload } from '@agroasys/sdk';

const payload: BuyerLockPayload = {
  supplier: '0xSupplierAddress...',
  totalAmount: 141_500_000n, // 141.50 USDC (6 decimals)
  logisticsAmount: 10_000_000n, //  10.00 USDC — logistics fee
  platformFeesAmount: 1_500_000n, //   1.50 USDC — platform fee
  supplierFirstTranche: 52_000_000n, //  52.00 USDC — 40% of net (Stage 1)
  supplierSecondTranche: 78_000_000n, //  78.00 USDC — 60% of net (Stage 2)
  ricardianHash: '0x3a4b5c6d...f1e2d3', // 32-byte SHA-256 of legal contract
  // deadline is optional; SDK defaults to now + 3600 s when omitted
};
```

## Field Reference

| Field                   | Type     | Required | Description                                                                                        |
| ----------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------- |
| `supplier`              | `string` | Yes      | EVM address of the supplier. Must be non-zero.                                                     |
| `totalAmount`           | `bigint` | Yes      | Total USDC amount the buyer locks. Must equal the sum of the four component fields.                |
| `logisticsAmount`       | `bigint` | Yes      | Logistics fee. Routed to `TreasuryWallet` at Stage 1.                                              |
| `platformFeesAmount`    | `bigint` | Yes      | Platform service fee. Routed to `TreasuryWallet` at Stage 1.                                       |
| `supplierFirstTranche`  | `bigint` | Yes      | First supplier payment, released at Stage 1 (ship-out). Protocol default: 40% of net. Must be > 0. |
| `supplierSecondTranche` | `bigint` | Yes      | Second supplier payment, released at Stage 2 (arrival). Protocol default: 60% of net. Must be > 0. |
| `ricardianHash`         | `string` | Yes      | `0x`-prefixed 32-byte hex SHA-256 of the off-chain legal contract. Immutable after lock.           |
| `deadline`              | `number` | No       | UNIX timestamp (seconds) after which the signature expires. SDK default: `now + 3600`.             |

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

Call the Ricardian service to anchor the legal document and receive the hash **before** assembling the `BuyerLockPayload`.

## Nonce and Deadline

### Nonce

The nonce is **not** part of `BuyerLockPayload`. The SDK derives the current
per-buyer on-chain nonce automatically:

```ts
const nonce = await this.getAuthorizationNonce(buyerAddress);
```

Checkout UIs MUST NOT pass a nonce.

## Compatibility note

`TradeParameters` remains exported as a backward-compatible alias for existing
integrations. New checkout implementations should prefer `BuyerLockPayload` so
the canonical contract is unambiguous across SDK docs and examples.

### Deadline

`deadline` is optional. When omitted, the SDK defaults to:

```ts
const deadline = payload.deadline ?? Math.floor(Date.now() / 1000) + 3600;
```

## USDC Pull Authorization

The direct buyer-paid `approve` plus `createTrade` flow is removed. For gasless
trade creation, collect a USDC receive authorization for the escrow contract and
send it with the signed create-trade authorization to the backend relayer.

The preferred SDK call builds both signatures and returns the gateway request:

```ts
const request = await buyerSDK.createGaslessTradeExecutionRequest(payload, buyerSigner, {
  handoffId: 'handoff-from-cotsel-gateway',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
});
```

The returned request contains stringified amounts and a `payloadHash` that the
Cotsel gateway recomputes before relaying.

### Failure and Retry Semantics

The preferred funding path is `receiveWithAuthorization`; do not fall back to a
standalone `approve` flow for the default checkout path.

- Treat the USDC authorization as retriable only while there is no confirmed
  Cotsel create-trade transaction and the token authorization nonce has not been
  consumed.
- If backend or Cotsel validation rejects the envelope before broadcast, the UI
  should ask the backend for a fresh quote/payload and collect a fresh buyer
  authorization instead of editing the failed payload.
- If simulation fails because the authorization is expired, not yet valid, has
  the wrong recipient, has the wrong amount, or mismatches the canonical quote,
  collect a fresh authorization; do not retry the same payload.
- If a transaction is submitted, keep retries idempotent through the backend
  request id and idempotency key. Do not create a second authorization for the
  same checkout attempt until the first submission is confirmed failed or
  expired without token nonce consumption.
- Once the create-trade transaction is confirmed, or the USDC authorization nonce
  is observed as used, consider that authorization spent. Future retries must use
  a new quote/payload and a new USDC authorization nonce.

If the preferred authorization path is temporarily unavailable, the fallback is
operational: pause gasless checkout for the affected chain, surface a failed
payment state, and let support restart the checkout with a fresh quote after the
incident is cleared. Do not silently switch users back to residual allowances.
