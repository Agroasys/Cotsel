# ADR-0142: Historical Pull-Over-Push Claim Settlement Model

- Status: Historical for buyer/supplier settlement; retained only for treasury fee sweep accounting
- Date: 2026-02-28
- Related issue: [#142](https://github.com/Agroasys/Cotsel/issues/142)

## Context

Escrow payout transitions previously transferred USDC directly during stage/dispute/timeout functions. This coupled core trade-state mutation with external token-transfer side effects and made payout-path failures harder to isolate.

## Historical Decision

ADR-0142 originally adopted a pull-over-push settlement model:

- Trade-state transitions accrue recipient entitlement into `claimableUsdc` via `ClaimableAccrued` events.
- Recipients withdraw accrued funds via `claim()`.
- `claim()` follows checks-effects-interactions and is `nonReentrant`.
- Claim-path control is split from global protocol pause:
  - `claim()` remains available during global pause.
  - `pauseClaims()` / `unpauseClaims()` provide dedicated emergency claim freeze.

This is no longer the active buyer/supplier payout model.

## Active Settlement Model

Issue `#528` restores direct supplier payout for active settlement flows, and PR `#530` restores direct buyer refunds. The current model is:

- Supplier first tranche, supplier second tranche, and dispute `RESOLVE` supplier proceeds transfer directly.
- Buyer lock-timeout refunds, in-transit timeout refunds, and dispute `REFUND` proceeds transfer directly.
- Treasury logistics/platform fee entitlements remain claim-based and are swept only through `claimTreasury()`.
- The generic `claim()` function is removed from the active contract version.
- Direct supplier payout emits `SupplierPayoutTransferred`; direct buyer refund emits `BuyerRefundTransferred`; treasury entitlements continue to emit `ClaimableAccrued`.

## Alternatives Considered

### A) Keep push payouts

- Pros: fewer transactions for recipients.
- Cons: external transfer failures/reentrancy risk remain coupled to state mutation paths.

### B) Pull-over-push (chosen)

- Pros: isolates transfer failures to claimant transaction, keeps state transitions deterministic, and reduces blast radius of transfer-path faults.
- Cons: recipients perform an extra claim transaction.

## Risk Analysis

### Reentrancy posture

- Supplier and buyer direct transfer paths are `nonReentrant` state-transition functions.
- `claimTreasury()` is `nonReentrant` and zeroes `claimableUsdc[treasuryAddress]` before transfer.
- Active state-transition functions accrue only treasury fee balances.

### Failure isolation

- If a supplier or buyer direct token transfer fails, the whole transition reverts and state is not advanced.
- If a treasury sweep transfer fails, only that treasury transaction reverts.
- Previously accrued treasury entitlements remain unaffected by failed buyer/supplier transition attempts.

### Pausability policy

- Global pause continues to block protocol mutation paths (`whenNotPaused` routes).
- Treasury sweep remains available unless dedicated `claimsPaused` is enabled.
- Rationale: preserve treasury access to already-accrued fee balances while retaining emergency claim freeze when the treasury claim path itself is at risk.

## Compatibility and Migration Notes

- Trade lifecycle semantics remain the same (LOCKED -> IN_TRANSIT -> CLOSED / dispute outcomes).
- Supplier payout delivery is direct for active settlement flows after issue `#528`.
- Buyer refund delivery is direct for active settlement flows after PR `#530`.
- Treasury payout delivery remains accrued entitlement + explicit `claimTreasury()` sweep.
- Event model includes deterministic treasury claim evidence (`ClaimableAccrued`, `TreasuryClaimed`) and direct payout execution evidence (`SupplierPayoutTransferred`, `BuyerRefundTransferred`).
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

- `pnpm --filter ./contracts run compile`
- `pnpm --filter ./contracts run test`
- relevant release-gate checks in CI

This restores legacy direct-transfer payout behavior.
