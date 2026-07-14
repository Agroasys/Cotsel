# EIP-7702 / Account Abstraction — Deferral Decision

- Status: Parked (decision recorded; not on the current roadmap)
- Date: 2026-07-13
- Scope: Settlement escrow signing model (`contracts/src/AgroasysEscrow.sol`) and the
  gasless funding/relayer paths

## Summary

We evaluated migrating the escrow's signing and gasless model to EIP-7702 (EOA-as-smart-account
delegation) and decided **not to migrate for v1**. The current EIP-712 +
EIP-3009 (`receiveWithAuthorization`) model stays as the settlement signing scheme. This
document records the reasoning and the specific conditions that would justify revisiting the
decision, so the analysis and the proof-of-concept work are not lost.

## Context

A PoC explored moving verification logic out of `AgroasysEscrow.sol` and into a
7702-delegated `Wallet.sol`. The initial framing was that 7702 mainly relocates verification
logic from the escrow into the wallet without removing any of the verification steps.

That framing understates our specific case. The verification inside the escrow is **not** just
signature plumbing that can be deleted:

- `CreateTradeAuthorization` (see the EIP-712 typehash in `contracts/src/AgroasysEscrow.sol`)
  binds the buyer's signature to the full trade breakdown — supplier, tranche amounts
  (`supplierFirstTranche` / `supplierSecondTranche`), logistics and platform fees, the
  Ricardian hash, plus `nonce` and `deadline`.
- All of that must still be validated inside the escrow regardless of where the signature is
  produced or recovered. Relocating the recovery step does not remove the binding checks.

## Why we are not migrating now

1. **The main practical benefit is already covered.** Our EIP-3009 `receiveWithAuthorization`
   funding flow already solves the biggest real-world problem 7702 targets — the
   approve-then-act friction. The gasless outcome we want is already achieved.

2. **It does not reduce signing friction for our flow.** In the 7702 PoC the user signs three
   things: the delegation tuple, the permit, and the `Execute` payload. Our current flow
   requires **two** signatures (the EIP-3009 USDC authorization + the
   `CreateTradeAuthorization` / `SponsoredAction`). Same gasless outcome, but 7702 adds moving
   parts rather than removing them.

3. **Blast radius and cost decisively favor the status quo.** Today, a bug in our signature
   scheme puts escrow funds at risk within a scoped, audited perimeter. Under 7702, `Wallet.sol`
   effectively becomes the code behind each user's entire EOA and every asset held in it, active
   until the user revokes the delegation. That is a much larger surface to own and would require
   a fresh audit around an entirely new trust model — precisely as we have finished hardening and
   proving the current approach on Base Sepolia.

4. **New non-crypto-native UX and lifecycle burden.** It introduces a new Web3Auth signing path
   for the delegation tuple, plus delegation lifecycle management (grant/revoke) for users who
   are not crypto-native.

## Revisit triggers

Reconsider EIP-7702 if **any** of the following lands on the roadmap:

1. Users need to interact gaslessly with **multiple contracts beyond the escrow**.
2. We decide to **retire our own relayer** and move to ERC-4337 bundlers and paymasters.
3. We need **batched, multi-step actions that EIP-3009 cannot express**.

## If we revisit

- The existing PoC is the starting reference point.
- Prefer an **audited delegate** (e.g. `Simple7702Account`) over building our own `Wallet.sol`.

## Related

- `contracts/src/AgroasysEscrow.sol` — `CreateTradeAuthorization` typehash, `SponsoredAction`,
  `UsdcAuthorization`, `receiveWithAuthorization` funding path
- `docs/runbooks/base-sepolia-gasless-settlement-proof.md` — current gasless settlement proof
- `docs/adr/adr-0411-human-governance-direct-wallet-signing.md` — related signing-model decision
