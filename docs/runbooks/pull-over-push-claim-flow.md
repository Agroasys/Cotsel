# Treasury Claim and Direct Payout Flow

## Purpose

This runbook describes the current escrow payout model after the issue `#142` claim migration, the issue `#528` supplier-payout update, and the PR `#530` buyer-refund update.

Current model:

- Supplier stage payouts are transferred directly by escrow transition functions.
- Buyer refunds are transferred directly by escrow refund functions.
- Treasury logistics/platform fee entitlements accrue in `claimableUsdc`.
- Treasury entitlements are swept through `claimTreasury()` to the configured treasury payout receiver.

## Decision Record

- ADR: `docs/adr/adr-0142-pull-over-push-claim-settlement.md`
- Canonical implementation PR chain:
  - `#151`, `#154`, `#165`, `#166`, `#167`, `#168`

## Behavior Change

- Issue `#142`: treasury/logistics/platform fee entitlements accrue claimable balances.
- Issue `#528`: supplier payouts are no longer claim-based in active settlement flows. `releaseFundsStage1`, `finalizeAfterDisputeWindow`, and dispute `RESOLVE` transfer supplier proceeds directly and emit `SupplierPayoutTransferred`.
- PR `#530`: buyer refunds are no longer claim-based in active settlement flows. Lock-timeout cancellation, in-transit timeout refund, and dispute `REFUND` transfer buyer refunds directly and emit `BuyerRefundTransferred`.
- The generic `claim()` function is removed from this contract version; only `claimTreasury()` remains.

## Payout Lifecycle

Treasury claim lifecycle:

1. Treasury-bearing transition executes.
2. Escrow emits `ClaimableAccrued(tradeId, treasuryAddress, amount, claimType)`.
3. Treasury identity/admin calls `claimTreasury()`.
4. Escrow emits `TreasuryClaimed(treasuryIdentity, payoutReceiver, amount, triggeredBy)`.

Supplier payout lifecycle:

1. Supplier-bearing transition executes.
2. Escrow transfers USDC directly to the supplier.
3. Escrow emits `SupplierPayoutTransferred(tradeId, supplier, amount, claimType, triggeredBy)`.

Buyer refund lifecycle:

1. Buyer refund transition executes.
2. Escrow transfers refundable principal directly to the buyer.
3. Escrow emits `BuyerRefundTransferred(tradeId, buyer, amount, claimType, triggeredBy)`.

## Treasury Identity vs Payout Receiver

- `treasuryAddress` is the immutable treasury identity used in:
  - trade signature preimage verification
  - treasury fee accrual accounting (`claimableUsdc[treasuryAddress]`)
- `treasuryPayoutAddress` is the rotatable payout destination for treasury sweeps.
- On deployments built from this contract version, `claimTreasury()` is destination-locked:
  - callable only by `treasuryAddress` or an admin
  - no destination parameter
  - sweeps only `claimableUsdc[treasuryAddress]`
  - transfers only to current `treasuryPayoutAddress`
  - emits `TreasuryClaimed(treasuryIdentity, payoutReceiver, amount, triggeredBy)`
- Existing non-upgradeable escrow addresses keep the behavior they were deployed with until services
  and dashboards are pointed at a newly deployed escrow version.

Operational consequence:

- routine sweeps must be triggered by the treasury identity or an admin signer.
- rotating payout destination does not change treasury identity and does not require signature-preimage changes.

## Safety Guarantees

- Supplier and buyer direct transfers happen inside `nonReentrant` escrow transition functions.
- Transition state is updated before the token transfer, and a failed token transfer reverts the whole transition.
- `claimTreasury()` uses checks-effects-interactions:
  - verifies `claimableUsdc[treasuryAddress] > 0`
  - sets treasury claimable balance to zero before token transfer
- `claimTreasury()` is `nonReentrant`.
- Failed treasury sweep transfer reverts that treasury transaction only; buyer/supplier direct payout paths do not use treasury claimable balances.

## Pause Policy Decision

- Policy split:
  - Global `paused` blocks protocol mutation paths (trade creation, stage transitions, dispute execution, timeout flows).
  - Direct buyer/supplier payout paths are blocked by global pause because they are protocol mutation paths.
  - `claimTreasury()` remains available during global pause unless dedicated `claimsPaused` is enabled.
  - Dedicated `claimsPaused` controls (`pauseClaims()` / `unpauseClaims()`) can freeze treasury sweeps during claim-path incidents.
- Incident decision matrix:
  - Use `pause()` for protocol mutation incidents.
  - Use `pauseClaims()` only for treasury claim/accounting/token-transfer incidents.
  - Use both if both risk surfaces are impacted.
- This behavior is test-backed in the repository-root path `./contracts/tests/AgroasysEscrow.ts`:
  - `Should direct-transfer buyer refund before global pause`
  - `Should keep buyer refunds automatic even when treasury claims are paused`
  - `Should allow treasury sweep during global pause when claims are not paused`
  - `Should block treasury sweep when claims are paused`

## Incident Flow: Treasury Receiver Compromise

Use this sequence when payout destination is compromised/lost/frozen:

1. Freeze claim path:

```bash
cast send <ESCROW_ADDRESS> "pauseClaims()" --private-key "$ADMIN_KEY"
```

2. Rotate payout receiver via governance (propose -> approve -> execute after timelock):

```bash
cast send <ESCROW_ADDRESS> "proposeTreasuryPayoutAddressUpdate(address)" <NEW_RECEIVER> --private-key "$ADMIN1_KEY"
cast send <ESCROW_ADDRESS> "approveTreasuryPayoutAddressUpdate(uint256)" <PROPOSAL_ID> --private-key "$ADMIN2_KEY"
# wait governance timelock
cast send <ESCROW_ADDRESS> "executeTreasuryPayoutAddressUpdate(uint256)" <PROPOSAL_ID> --private-key "$ADMIN1_KEY"
```

AdminSDK equivalent for automation:

```ts
const adminSDK = new AdminSDK({ rpc, chainId, escrowAddress, usdcAddress });

await adminSDK.pauseClaims(admin1Signer);
const proposal = await adminSDK.proposeTreasuryPayoutAddressUpdate(newReceiver, admin1Signer);
await adminSDK.approveTreasuryPayoutAddressUpdate(proposal.proposalId!, admin2Signer);
// wait governance timelock
await adminSDK.executeTreasuryPayoutAddressUpdate(proposal.proposalId!, admin1Signer);
await adminSDK.unpauseClaims(admin1Signer);
```

3. Verify rotation on-chain:

```bash
cast call <ESCROW_ADDRESS> "treasuryPayoutAddress()(address)"
```

4. Unfreeze claim path:

```bash
cast send <ESCROW_ADDRESS> "unpauseClaims()" --private-key "$ADMIN_KEY"
```

## Operator Verification

Use these checks during incident triage or release verification:

**Production execution:** Admins run these actions through the Web2 admin dashboard, which calls the AdminSDK to submit transactions (`sdk/src/modules/adminSDK.ts`). The Foundry commands below are a reproducible fallback for audits, incident response, or manual verification when the dashboard path is unavailable.

```bash
cast call <ESCROW_ADDRESS> "claimableUsdc(address)(uint256)" <RECIPIENT>
cast call <ESCROW_ADDRESS> "treasuryPayoutAddress()(address)"
```

Expected for active settlement balances:

- Treasury has non-zero value after fee accrual events.
- Treasury is zero after successful `claimTreasury()`.
- Treasury sweep always pays the configured `treasuryPayoutAddress`.
- Supplier stage payouts should not create `claimableUsdc(supplier)` in active settlement flows.
- Buyer refund paths should not create `claimableUsdc(buyer)` in active settlement flows.

## Event Mapping

- `ClaimableAccrued`: deterministic entitlement creation.
- `TreasuryClaimed`: treasury-identity entitlement payout execution to payout receiver.
- `SupplierPayoutTransferred`: successful direct supplier payout execution.
- `BuyerRefundTransferred`: successful direct buyer refund execution.
- `TreasuryPayoutAddressUpdateProposed` / `...Approved` / `...Updated` / `...ProposalExpiredCancelled`: payout receiver governance lineage.
- Existing business events (`FundsReleasedStage1`, `FinalTrancheReleased`, `DisputePayout`, timeout events) still mark trade-state transitions.

## Non-Upgradeable Migration Reality

- Existing escrow deployments are not upgraded in place.
- During migration windows, run dual monitoring for:
  - old escrow addresses with residual `claimableUsdc`
  - new escrow address with active flows
- Drain requirement before declaring migration complete:
  - `claimableUsdc(treasuryAddress) == 0` on all legacy escrow addresses
  - no unresolved incident tickets on payout receiver rotation
  - reconciliation report shows no treasury leakage across old/new escrows

## Rollback

If rollback is required, revert the relevant claim or supplier-payout PR commit chain and validate with:

```bash
pnpm --filter ./contracts run compile
pnpm --filter ./contracts run test
```

## Foundry Test Gate

- Hardhat test suites are the release gate for this migration:
  - `contracts/tests/AgroasysEscrow.ts`
  - `contracts/tests/AgroasysEscrow.claim-security.ts`
- Foundry coverage for claim and direct supplier-payout behavior exists in:
  - `contracts/foundry/test/AgroasysEscrowFuzz.t.sol`
  - `contracts/foundry/test/AgroasysEscrowInvariant.t.sol`
- Run Foundry with `pnpm --filter ./contracts run test:foundry` (requires `forge` on `PATH`).
- Keep Foundry migration/verification as a follow-up gate before promoting Foundry as a required merge check.
