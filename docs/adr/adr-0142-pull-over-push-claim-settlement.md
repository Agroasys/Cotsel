# ADR-0142: Pull-Over-Push Claim Settlement Model

- Status: Accepted
- Date: 2026-02-28
- Related issue: [#142](https://github.com/Agroasys/Cotsel/issues/142)

## Context

Escrow payout transitions previously transferred USDC directly during stage/dispute/timeout functions. This coupled core trade-state mutation with external token-transfer side effects and made payout-path failures harder to isolate.

## Decision

Adopt a pull-over-push settlement model:

- Trade-state transitions accrue recipient entitlement into `claimableUsdc` via `ClaimableAccrued` events.
- Recipients withdraw accrued funds via `claim()`.
- `claim()` follows checks-effects-interactions and is `nonReentrant`.
- Claim-path control is split from global protocol pause:
  - `claim()` remains available during global pause.
  - `pauseClaims()` / `unpauseClaims()` provide dedicated emergency claim freeze.

## Alternatives Considered

### A) Keep push payouts

- Pros: fewer transactions for recipients.
- Cons: external transfer failures/reentrancy risk remain coupled to state mutation paths.

### B) Pull-over-push (chosen)

- Pros: isolates transfer failures to claimant transaction, keeps state transitions deterministic, and reduces blast radius of transfer-path faults.
- Cons: recipients perform an extra claim transaction.

## Risk Analysis

### Reentrancy posture

- `claim()` is `nonReentrant` and zeroes `claimableUsdc[msg.sender]` before transfer.
- State-transition functions accrue balances rather than transferring directly.

### Failure isolation

- If a claimant transfer fails, only that claim transaction reverts.
- Other recipients and previously accrued entitlements are unaffected.

### Pausability policy

- Global pause continues to block protocol mutation paths (`whenNotPaused` routes).
- Claim path remains available unless dedicated `claimsPaused` is enabled.
- Rationale: preserve non-custodial access to already-accrued balances while retaining emergency claim freeze when claim path itself is at risk.

## Compatibility and Migration Notes

- Trade lifecycle semantics remain the same (LOCKED -> IN_TRANSIT -> CLOSED / dispute outcomes).
- Payout delivery changed from immediate transfer to accrued entitlement + explicit claim withdrawal.
- Event model now includes deterministic entitlement/claim evidence (`ClaimableAccrued`, `Claimed`).
- In-flight trades keep their current state semantics. Entitlements accrue when transition functions execute under the pull model; no retroactive "backfill transfer" is required for already-paid legacy transitions.

## Evidence

### Canonical implementation PRs

- [#151](https://github.com/Agroasys/Cotsel/pull/151)
- [#154](https://github.com/Agroasys/Cotsel/pull/154)
- [#165](https://github.com/Agroasys/Cotsel/pull/165)
- [#166](https://github.com/Agroasys/Cotsel/pull/166)
- [#167](https://github.com/Agroasys/Cotsel/pull/167)
- [#168](https://github.com/Agroasys/Cotsel/pull/168)

### Runbooks

- [pull-over-push-claim-flow.md](../runbooks/pull-over-push-claim-flow.md)

### CI evidence

- PR #151 release-gate run: https://github.com/Agroasys/Cotsel/actions/runs/22518631770
- PR #154 contracts/release-gate run: https://github.com/Agroasys/Cotsel/actions/runs/22518757426

## Rollback

If rollback is required, revert implementation commits from the migration PR chain starting at #151 (and dependent policy/indexer/sdk follow-ups), then validate:

- `npm run -w contracts compile`
- `npm -w contracts test`
- relevant release-gate checks in CI

This restores legacy direct-transfer payout behavior.
