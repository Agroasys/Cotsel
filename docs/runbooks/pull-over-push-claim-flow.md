# Pull-Over-Push Claim Flow

## Purpose

This runbook describes the escrow payout model after issue `#142` migration from direct push transfers to pull-based `claim()` settlement.

## Behavior Change

- Before: payout transitions (`releaseFundsStage1`, `finalizeAfterDisputeWindow`, timeout handlers, dispute execution) transferred USDC immediately.
- After: those transitions now accrue claimable balances per recipient in `claimableUsdc`.
- Recipients must call `claim()` to withdraw accrued USDC.

## Claim Lifecycle

1. Trade transition executes (stage1/stage2/timeout/dispute).
2. Escrow emits `ClaimableAccrued(tradeId, recipient, amount, claimType)`.
3. Recipient calls `claim()`.
4. Escrow emits `Claimed(claimant, amount)`.

## Safety Guarantees

- `claim()` uses checks-effects-interactions:
  - verifies `claimableUsdc[msg.sender] > 0`
  - sets claimable balance to zero before token transfer
- `claim()` is `nonReentrant`.
- Failed claim transfer reverts that claimant transaction only; other recipients' claimable balances remain unaffected.

## Pause Policy Decision

- Policy: `claim()` is blocked while protocol pause is active (`whenNotPaused`).
- Reason: during emergency containment, we freeze all normal fund-out operations until admins finish incident triage.
- Operational safety: claims resume through the existing quorum unpause path:
  1. `proposeUnpause()`
  2. `approveUnpause()`
  3. recipients retry `claim()`
- This behavior is test-backed in `contracts/tests/AgroasysEscrow.ts` (`Should block claims while paused and allow claims again after quorum unpause`).

## Operator Verification

Use these checks during incident triage or release verification:

```bash
cast call <ESCROW_ADDRESS> "claimableUsdc(address)(uint256)" <RECIPIENT>
```

Expected:
- Non-zero value after accrual events.
- Zero after successful `claim()`.

## Event Mapping

- `ClaimableAccrued`: deterministic entitlement creation.
- `Claimed`: successful withdrawal execution.
- Existing business events (`FundsReleasedStage1`, `FinalTrancheReleased`, `DisputePayout`, timeout events) still mark trade-state transitions.

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
- Foundry parity could not be executed in this environment because `forge` is unavailable (`npm run -w contracts test:foundry` fails with `forge: command not found`).
- Treat Foundry migration/verification as a follow-up environment gate before promoting Foundry as a required check.
