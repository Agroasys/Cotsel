# Base Sepolia Gasless Settlement Proof

## Purpose

Prove that gasless settlement v1 works on Base Sepolia before any mainnet rollout.
This proof is specifically about user friction: buyers and suppliers must not need
ETH for the default create-trade, supplier-payout, or buyer-refund paths.

## Required Command

Run the rehearsal packet generator with a deterministic window id:

```bash
pnpm run pilot:rehearsal --window-id <window-id> --bring-up-profile
```

For CI or repo-local validation only:

```bash
pnpm run pilot:rehearsal --window-id <window-id> --config-only
```

Config-only output is not a live Base Sepolia proof. A live proof requires the
generated packet under `reports/base-sepolia-pilot-validation/<window-id>/` to be
completed with real transaction, relayer, treasury, and reconciliation evidence.

## Required Live Flows

1. Buyer deposit / create trade:
   - buyer authenticates through Agroasys session handling
   - buyer signs with Web3Auth wallet
   - buyer wallet has zero ETH before the action
   - relayer submits the gasless action
   - escrow emits the create-trade/funding evidence

2. Supplier payout:
   - supplier wallet has zero ETH before and after the action
   - payout transfers directly to the supplier wallet
   - no supplier `claim()` transaction is required

3. Buyer refund:
   - exercise one dispute or timeout refund path
   - buyer wallet has zero ETH before and after the refund
   - refund transfers directly to the buyer wallet
   - no buyer `claim()` transaction is required

## Accounting And Reconciliation Evidence

The packet must include:

- relayer request id, idempotency key, and tx hash for each sponsored action
- gas spend record for each sponsored action
- indexer events for relayed execution, supplier payout, and buyer refund
- treasury ledger entries for logistics, net platform fee, and settlement support fee
- reconciliation report proving gross platform fee and split fee components agree
- explicit note that reconciliation did not depend on transaction sender as buyer/supplier proof

## Failure Handling

Exercise and record:

- expired authorization rejection before fund movement
- repeated failed submission without duplicate settlement
- relayer outage or disabled-relayer behavior
- fallback UX, with ETH top-up treated only as support tooling

## Go / No-Go

Go only when all required live flows pass with zero user ETH and the generated
`rollout-checklist.md` has no unresolved no-go condition.

No-go if any default buyer, supplier, or buyer-refund path needs user ETH, if
support fee is collapsed into platform fee, if reconciliation has unresolved
CRITICAL drift, or if relayer failure creates ambiguous fund movement.

## Related Runbooks

- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/base-mainnet-go-no-go.md`
- `docs/runbooks/base-mainnet-cutover-and-rollback.md`
