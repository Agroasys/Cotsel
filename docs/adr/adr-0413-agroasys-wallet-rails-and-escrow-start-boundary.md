# ADR-0413: Agroasys Wallet Rails and Escrow Start Boundary

- Status: Accepted
- Date: 2026-07-16

## Context

Agroasys participants can fund or withdraw their business-account balance through Bridge, and can
also receive or send USDC through their verified embedded wallet. These participant wallet movements
are not order settlement. Cotsel remains the settlement provider for an order only after the buyer
explicitly approves the complete payment package.

The order payment package includes the supplier order amount, the confirmed logistics fee, and the
Agroasys fees defined by the launch settlement schedule. Contract signatures and logistics fee
confirmation establish readiness, but neither event transfers funds into Cotsel.

## Decision

1. Agroasys owns automatic direct participant USDC receipt discovery, send intents, chain
   verification, participant-ledger posting, balance reservation, activity history, and
   reconciliation. Customers do not manually submit receipt transaction hashes.
2. Cotsel does not expose a generic participant-to-wallet transfer function and does not become the
   participant accounting ledger.
3. Agroasys may call the Cotsel trade-creation/funding path only after both parties have signed, the
   selected logistics quotation has been accepted, its fee has been confirmed, and the buyer has
   explicitly selected **Pay now** and approved the exact payment package.
4. A quotation, fee confirmation, or Agroasys ledger reservation is not proof that Cotsel escrow has
   started. Escrow starts only when the contract lock succeeds and the resulting chain state is
   reconciled back to Agroasys.
5. The existing Cotsel launch schedule and amount validation remain authoritative for the on-chain
   60/40 order settlement. Direct wallet transfers must never call or reuse those order-release
   functions.

## Security Invariants

- An external USDC receipt cannot create order escrow or satisfy an order milestone by itself.
- A direct wallet send cannot spend funds already transferred to escrow or participant claims held by
  Cotsel.
- A Bridge deposit and a direct receipt observer cannot post the same destination chain event twice;
  Agroasys retains one authoritative ledger owner for that event.
- Cotsel rejects a malformed order settlement package even if Agroasys marked the order ready to pay.
- Agroasys treats a submitted Cotsel transaction as pending until chain confirmation and reconciliation;
  a browser response alone is not settlement truth.
- Removing compatibility-only contract functions is handled separately from this boundary decision;
  this ADR adds no backwards-compatibility surface to the non-upgradeable escrow contract.

## Consequences

Participants get familiar crypto receive/send controls without expanding the escrow contract into a
general wallet. Agroasys must operate the USDC receipt/send reconciler and retain an auditable link
between verified chain transactions and ledger entries. Cotsel remains narrower: it validates and
executes funded order settlement after explicit buyer approval.
