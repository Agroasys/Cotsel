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

- Policy split:
  - Global `paused` blocks protocol mutation paths (trade creation, stage transitions, dispute execution, timeout flows).
  - `claim()` remains available during global pause to preserve non-custodial access to already-accrued balances.
  - Dedicated `claimsPaused` controls (`pauseClaims()` / `unpauseClaims()`) can freeze claims during claim-path incidents.
- Incident decision matrix:
  - Use `pause()` for protocol mutation incidents.
  - Use `pauseClaims()` only for claim/accounting/token-transfer incidents.
  - Use both if both risk surfaces are impacted.
- This behavior is test-backed in the repository-root path `./contracts/tests/AgroasysEscrow.ts`:
  - `Should allow claims while globally paused when claim freeze is not active`
  - `Should enforce dedicated claim freeze and restore claim after unpauseClaims`

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
- Foundry coverage for pull-over-push behavior exists in:
  - `contracts/foundry/test/AgroasysEscrowFuzz.t.sol`
  - `contracts/foundry/test/AgroasysEscrowInvariant.t.sol`
- Run Foundry with `npm run -w contracts test:foundry` (requires `forge` on `PATH`).
- Keep Foundry migration/verification as a follow-up gate before promoting Foundry as a required merge check.
