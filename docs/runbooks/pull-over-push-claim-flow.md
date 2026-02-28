# Pull-Over-Push Claim Flow

## Purpose

This runbook describes the escrow payout model after issue `#142` migration from direct push transfers to pull-based `claim()` settlement.

## Decision Record

- ADR: `docs/adr/adr-0142-pull-over-push-claim-settlement.md`
- Canonical implementation PR chain:
  - `#151`, `#154`, `#165`, `#166`, `#167`, `#168`

## Behavior Change

- Before: payout transitions (`releaseFundsStage1`, `finalizeAfterDisputeWindow`, timeout handlers, dispute execution) transferred USDC immediately.
- After: those transitions now accrue claimable balances per recipient in `claimableUsdc`.
- Recipients must call `claim()` to withdraw accrued USDC.

## Claim Lifecycle

1. Trade transition executes (stage1/stage2/timeout/dispute).
2. Escrow emits `ClaimableAccrued(tradeId, recipient, amount, claimType)`.
3. Recipient calls `claim()`.
4. Escrow emits `Claimed(claimant, amount)`.

## Treasury Identity vs Payout Receiver

- `treasuryAddress` is the immutable treasury identity used in:
  - trade signature preimage verification
  - treasury fee accrual accounting (`claimableUsdc[treasuryAddress]`)
- `treasuryPayoutAddress` is the rotatable payout destination for treasury withdrawals.
- `claimTreasury()` is destination-locked:
  - no destination parameter
  - sweeps only `claimableUsdc[treasuryAddress]`
  - transfers only to current `treasuryPayoutAddress`
  - emits `TreasuryClaimed(treasuryIdentity, payoutReceiver, amount, triggeredBy)`

Operational consequence:
- treasury signing key usage is no longer required for routine sweeps.
- rotating payout destination does not change treasury identity and does not require signature-preimage changes.

## Safety Guarantees

- `claim()` uses checks-effects-interactions:
  - verifies `claimableUsdc[msg.sender] > 0`
  - sets claimable balance to zero before token transfer
- `claim()` is `nonReentrant`.
- Failed claim transfer reverts that claimant transaction only; other recipients' claimable balances remain unaffected.

## Pause Policy Decision

- Policy split:
  - Global `paused` blocks protocol mutation paths (trade creation, stage transitions, dispute execution, timeout flows).
  - `claim()` remains available during global pause to preserve non-custodial access to already-accrued balances.
  - `claimTreasury()` follows the same claim-path posture as `claim()`.
  - Dedicated `claimsPaused` controls (`pauseClaims()` / `unpauseClaims()`) can freeze claims during claim-path incidents.
- Incident decision matrix:
  - Use `pause()` for protocol mutation incidents.
  - Use `pauseClaims()` only for claim/accounting/token-transfer incidents.
  - Use both if both risk surfaces are impacted.
- This behavior is test-backed in the repository-root path `./contracts/tests/AgroasysEscrow.ts`:
  - `Should allow claims while globally paused when claim freeze is not active`
  - `Should enforce dedicated claim freeze and restore claim after unpauseClaims`
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

Expected:
- Non-zero value after accrual events.
- Zero after successful `claim()`.
- Treasury sweep always pays the configured `treasuryPayoutAddress`.

## Event Mapping

- `ClaimableAccrued`: deterministic entitlement creation.
- `Claimed`: successful withdrawal execution.
- `TreasuryClaimed`: treasury-identity entitlement payout execution to payout receiver.
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

If rollback is required, revert the pull-over-push PR commit to restore prior direct-transfer behavior. Validate post-rollback with:

```bash
npm run -w contracts compile
npm -w contracts test
```

## Foundry Test Gate

- Hardhat test suites are the release gate for this migration:
  - `contracts/tests/AgroasysEscrow.ts`
  - `contracts/tests/AgroasysEscrow.claim-security.ts`
- Foundry coverage for pull-over-push behavior exists in:
  - `contracts/foundry/test/AgroasysEscrowFuzz.t.sol`
  - `contracts/foundry/test/AgroasysEscrowInvariant.t.sol`
- Run Foundry with `npm run -w contracts test:foundry` (requires `forge` on `PATH`).
- Keep Foundry migration/verification as a follow-up gate before promoting Foundry as a required merge check.
