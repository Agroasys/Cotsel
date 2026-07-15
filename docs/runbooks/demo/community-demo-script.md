# Community Demo Script — Agroasys Non-Custodial Settlement Lifecycle

## Purpose

Step-by-step narration guide for demonstrating the full Agroasys settlement lifecycle to a public pilot audience.

## Architecture Reference

See `README.md` and `docs/runbooks/hybrid-split-walkthrough.md` for full lifecycle context.

## Demo Trade Parameters

All values are illustrative for the demo session:

| Field                   | Demo Value    |
| ----------------------- | ------------- |
| Supplier goods value    | 1,000 USDC    |
| `totalAmount`           | 1,064 USDC    |
| `logisticsAmount`       | 50 USDC       |
| `platformFeesAmount`    | 19 USDC       |
| `supplierFirstTranche`  | 595 USDC      |
| `supplierSecondTranche` | 400 USDC      |
| `tradeId`               | 0             |
| `documentRef`           | (to complete) |

## Act 1 — Ricardian Proof: Anchoring the Legal Agreement

> Before USDC are locked, the protocol enforces a hash-first contract architecture. The PDF trade agreement is hashed off-chain, and only the SHA-256 fingerprint is anchored on-chain. This means any court or auditor can mathematically verify that the funds correspond to the exact contract signed by both parties.

**Demo steps:**

### Step 1.1 — Generate the Ricardian hash

**Show:**

- `canonicalJson` — the deterministic serialization of the trade agreement fields.
- `hash` — 64-character lowercase hex anchored on-chain.
- `rulesVersion: RICARDIAN_CANONICAL_V1` — the versioned canonicalization standard.

**Talking point:**

> "Notice the hash is deterministic. Every time you feed the same trade terms, you get the same hash. There is no ambiguity about what was agreed."

### Step 1.2 — Retrieve the stored hash via API

```bash
curl -fsS "http://127.0.0.1:${RICARDIAN_PORT:-3100}/api/ricardian/v1/hash/<hash-from-step-1.1>"
```

**Show:** `documentRef`, `hash`, `rulesVersion`, `createdAt` in the response.

## Act 2 — Login: Buyer Authentication and Session Setup (Web3Auth)

> The protocol is non-custodial; the platform never holds the buyer's private key. Wallet creation uses Web3Auth, which provides a frictionless UX while the user retains full custody of their signing key. The session produces a signer that is used for all subsequent contract interactions.

**Demo steps:**

### Step 2.1 Buyer creates a wallet via Web3Auth

> Web3Auth is not the authentication method used to connect to the Agroasys website. The buyer connects to the website first; then a wallet is created based on the session.

**Show:**

- The Web3Auth modal opens, the buyer logs in, and the wallet loads based on the session (no seed phrase required).
- The session resolves to a deterministic wallet address.
- `buyerAddress` is displayed; this is the address that will be recorded on-chain as the trade payer.

> Notice that the buyer never sees a private key or seed phrase. Web3Auth uses threshold key management under the hood: the key is split across devices and the authentication provider, so no single party — including Agroasys — can access it. Yet the resulting signer is fully EVM-compatible and signs the escrow transaction directly.

### Step 2.2 — Verify the buyer’s USDC balance before lock

**Show:** The balance is sufficient for the 10,000 USDC lock.

## Act 3 — Lock: Buyer Deposits Funds into Escrow

> Now the buyer locks the full trade value into the non-custodial escrow contract. The contract is a state machine — it enforces every transition. No one can skip steps or move funds outside the defined lifecycle.

**Demo steps:**

### Step 3.1 — Buyer creates trade (SDK call)

Show the SDK usage pattern:

```typescript
// (6 decimals)
const tradeParams = {
  supplier: 'supplier-address',
  totalAmount: parseUSDC('1064'),
  logisticsAmount: parseUSDC('50'),
  // Buyer fee 10 + fixed support fee 4 + supplier fee 5
  platformFeesAmount: parseUSDC('19'),
  // Gross first tranche 600 less supplier fee 5
  supplierFirstTranche: parseUSDC('595'),
  supplierSecondTranche: parseUSDC('400'),
  ricardianHash: 'ricardian-hash',
};

const gaslessRequest = await buyerSDK.createGaslessTradeExecutionRequest(tradeParams, buyerSigner, {
  handoffId: 'demo-handoff-id',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
});
```

**Show:**

- Buyer signs typed authorizations; the relayer submits the gasless request.
- `TradeLocked` event emitted on-chain after relayer submission.
- Trade status transitions to `LOCKED`.
- Escrow balance increases by 10,000 USDC.
- Buyer balance decreases by 10,000 USDC.

### Step 3.2 — Verify indexed state

```bash
curl -fsS "${INDEXER_GRAPHQL_URL}" \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ tradeEvents(filter:{tradeId:{equalTo:\"0\"}}) { nodes { tradeId status txHash blockNumber } } }"}'
```

**Show:** `TradeLocked` event indexed with `tradeId`, `txHash`, `blockNumber`.

## Act 4 — Stage 1 Release: Oracle Verifies Documentation

> The oracle bridges real-world logistics events to on-chain action. When the Bill of Lading and Export Permit are validated off-chain, the oracle triggers an atomic on-chain transaction that simultaneously pays logistics, platform fees, and the supplier's first tranche, all in a single transaction. No human can intercept or redirect any of these flows.

**Demo steps:**

### Step 4.1 — Oracle triggers Stage 1 release

Show the oracle trigger API (in `ORACLE_MANUAL_APPROVAL_ENABLED=true` mode for demo safety).

**Show:** Trigger status is `PENDING_APPROVAL`, no blockchain call made yet.

> In pilot mode, every oracle action requires an explicit human approval step. This is a safety control, operators review the trigger before any funds move.

### Step 4.2 — Operator reviews and approves (Manual Approval Mode)

Pre-approval checklist (narrate each item):

- Confirm `trade_id`, `trigger_type`, `created_at` on the pending trigger.
- Confirm no other active trigger for the same `action_key`.
- Verify on-chain trade status is `LOCKED` (required pre-condition for `RELEASE_STAGE_1`).
- Confirm no recent `CONFIRMED` trigger for the same `action_key`.

**Show:** Trigger moves to `SUBMITTED`, then `CONFIRMED`.

### Step 4.3 — Verify on-chain disbursement

**Show audience events emitted:**

- `FundsReleasedStage1(tradeId, supplier, 595 USDC, treasury, 50 USDC)`
- `PlatformFeesPaidStage1(tradeId, treasury, 19 USDC)`

**Show audience state:**

- Trade status: `IN_TRANSIT`
- Supplier received: 595 USDC (60% gross less the 0.5% full-order supplier fee)
- Treasury claimable: 69 USDC (50 logistics + 10 buyer fee + 4 support + 5 supplier fee)
- Escrow still protects: 400 USDC (the remaining 40% supplier principal)

## Act 5 — Goods Available For Inspection

> Arrival alone does not start settlement. After the goods are discharged or delivered into custody and are actually available for inspection, the oracle starts the order's inspection-notice window. Ordinary bulk agricultural deliveries use 72 hours; explicitly classified packaged-local deliveries use 48 hours.

**Demo steps:**

### Step 5.1 — Oracle records inspection availability

Approve as in Step 3.2 (with `ORACLE_MANUAL_APPROVAL_ENABLED=true`):

> Goods are available for weighing, sampling, and inspection at the contracted location.

**Show audience:**

- `InspectionAvailable(tradeId, inspectionAvailableAt, windowSeconds, deadline)` event emitted.
- Trade status: `ARRIVAL_CONFIRMED`.
- Exact 48- or 72-hour notice deadline is now recorded.

> The buyer can accept the inspected goods immediately, which releases the remaining 400 USDC without waiting. If the buyer reports no problem, the protocol releases the 400 USDC automatically at the exact notice deadline. A 7- or 14-day evidence period exists only after an active dispute has already placed the final tranche on hold.

## Act 6 — Final Settlement: Dispute Window Elapses

**Narrator prompt:**

> "No dispute was raised. The order's notice deadline has elapsed. The protocol finalizes the trade."

**Demo steps:**

### Step 6.1 — Finalize after dispute window

**Show:**

- `FinalTrancheReleased(tradeId, supplier, 400 USDC)` event emitted.
- Trade status: `CLOSED`.
- Escrow balance: 0 USDC for this trade.
- Supplier total received: 4,000 + 4,500 = 8,500 USDC.

> The trade is complete. Every step is permanently recorded on-chain, indexed in our GraphQL layer, reconciled against off-chain state, and anchored to the original Ricardian legal agreement. This is a full, auditable, trustless settlement.

## Act 7 — Reconciliation: On-Chain vs. Off-Chain Integrity Check

> After every trade, the reconciliation service automatically compares on-chain state against indexed data. Any mismatch, amount, participant, hash, status, is classified by severity and surfaced for investigation.

**Demo steps:**

### Step 7.1 — Run reconciliation

**Show:**

- `Reconciliation run completed`, no CRITICAL drift.
- Drift classification snapshot shows clean state for the trade.

> The reconciliation layer is the protocol's immune system. If any indexed data drifts from on-chain truth, it's detected, classified, and flagged for remediation.

## Act 8 — Dispute Path (Extended Demo)

**Narrator prompt:**

> Let's demonstrate what happens when a buyer raises a quality dispute. The protocol freezes the second tranche immediately and routes the case to the admin multi-sig governance.

**Demo steps:**

- Create a second trade (T2 from E2E matrix).
- Progress through Stage 1 and Arrival Confirmation.
- Buyer calls `openDispute` within the order's 72-hour standard or explicitly selected 48-hour packaged-local notice window.
- Admin 1 proposes `RESOLVE` (supplier keeps second tranche) or `REFUND` (buyer receives second tranche).
- Admin M approves -> execution is automatic at M-of-N approval threshold.

**Show:**

- `DisputeOpenedByBuyer(tradeId)` → status `FROZEN`.
- `DisputeSolutionProposed(proposalId, tradeId, RESOLVE, admin1)`.
- `DisputePayout(tradeId, proposalId, supplier, 4_500, RESOLVE)` -> status `CLOSED`.

> Notice that even in the dispute path, no single admin can unilaterally move funds. It requires multi-sig governance approval, and every proposal and approval is permanently on-chain.

## Architecture Alignment Statement

> All demo steps reflect the documented lifecycle in `docs/runbooks/hybrid-split-walkthrough.md`.

## Related References

- `docs/runbooks/hybrid-split-walkthrough.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/runtime-release-gate.md`
