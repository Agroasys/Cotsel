# Reconciliation Runbook

## Purpose
Operate reconciliation safely in local/staging and diagnose drift failures.
For lifecycle checkpoints across lock, stage-1, and final settlement, see `docs/runbooks/hybrid-split-walkthrough.md`.
If a mismatch may be caused by routing/auth propagation/correlation breakdown between services, use `docs/runbooks/api-gateway-boundary.md` first to classify the handoff boundary before remediating reconciliation state.

## Preconditions
- Postgres is reachable.
- Reconciliation env vars are set (`RPC_URL`, `INDEXER_GRAPHQL_URL`, addresses).
- RPC endpoint is reachable from runtime.

## Commands

Run once:

```bash
npm run -w reconciliation reconcile:once
```

Run daemon:

```bash
npm run -w reconciliation reconcile:daemon
```

Docker local-dev profile:

```bash
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev
scripts/docker-services.sh logs local-dev reconciliation
```

## Expected outputs
- `Reconciliation daemon started`
- `Validating RPC endpoint for reconciliation startup`
- `Reconciliation run completed`

## Deterministic Drift Classifications
Source of truth: `reconciliation/src/core/classifier.ts`.

The classifier emits deterministic mismatch codes:
- `ONCHAIN_READ_ERROR`
- `ONCHAIN_TRADE_MISSING`
- `STATUS_MISMATCH`
- `PARTICIPANT_MISMATCH`
- `AMOUNT_MISMATCH`
- `HASH_MISMATCH`
- `ARRIVAL_TIMESTAMP_MISMATCH`
- `INDEXED_INVALID_ADDRESS`
- `ONCHAIN_INVALID_ADDRESS`

Severity mapping is deterministic by code path:
- `CRITICAL`: on-chain read/missing, participant mismatch, amount mismatch, hash mismatch, invalid addresses
- `HIGH`: status mismatch
- `MEDIUM`: arrival timestamp mismatch

## Treasury Sweep Reconciliation Invariants

When pull-over-push treasury sweep is enabled, use these deterministic checks:

- Treasury accrual source:
  - sum `ClaimableAccrued` where `claimRecipient == treasuryAddress`
- Treasury payout execution sources:
  - sum `Claimed.claimAmount` where `triggeredBy == treasuryAddress` (direct treasury key path)
  - sum `TreasuryClaimed.claimAmount` (destination-locked sweep path)
- Outstanding treasury entitlement:
  - on-chain `claimableUsdc(treasuryAddress)`

Conservation formula (per escrow address):

```text
TreasuryAccruedTotal
  = TreasuryClaimedDirectTotal
  + TreasuryClaimedSweepTotal
  + TreasuryOutstandingClaimable
```

Failure interpretation:
- If left side > right side: missing payout or stale claimable snapshot.
- If right side > left side: duplicate accounting or event ingestion bug.
- Any mismatch across runs for same escrow is `CRITICAL` until explained.

## Migration: Dual-Escrow Reconciliation

Escrow contracts are not upgraded in place. During migration:
- run reconciliation per escrow address (legacy + new)
- preserve separate conservation checks for each escrow
- compute global view only as sum of per-escrow invariant outputs

Migration is complete only when:
- legacy escrows have zero outstanding treasury claimables
- expected treasury payout events from legacy escrows are fully matched to treasury ledger entries
- no unresolved payout receiver rotation incidents remain

## Retry/Redrive State Machine
Source of truth:
- `reconciliation/src/core/reconciler.ts`
- `reconciliation/src/database/queries.ts`
- `oracle/src/core/trigger-manager.ts`
- `oracle/src/worker/confirmation-worker.ts`

Reconciliation run state transitions:
- `RUNNING`:
  - set when `createRun(runKey, mode)` inserts a new row
- `COMPLETED`:
  - set by `completeRun(stats)` after processing batches
- `FAILED`:
  - set by `failRun(runKey, error)` on unexpected run failure
- `SKIPPED`:
  - returned when the same `run_key` is already `COMPLETED` or `RUNNING` (idempotency guard)

Reconciliation retry semantics:
- No unbounded per-trade retry loop inside one run.
- Daemon retries happen only by scheduling the next run interval.
- Drift rows use upsert semantics (`run_key`, `trade_id`, `mismatch_code`, `compared_field`) and increment `occurrences` on duplicates.

Oracle retry/redrive semantics (for settlement action remediation):
- Retry loop with bounded attempts and backoff in `TriggerManager`.
- Terminal outcomes: `TERMINAL_FAILURE` or `EXHAUSTED_NEEDS_REDRIVE`.
- Manual redrive and on-chain fallback flow are documented in `docs/runbooks/oracle-redrive.md`.

## Staging Gate Evidence Output
`scripts/staging-e2e-real-gate.sh` captures both:
- reconciliation run summary:
  - output prefix: `reconciliation run summary:`
- drift snapshot:
  - output prefix: `drift classification snapshot:`
- treasury payout path evidence:
  - `TreasuryClaimed` and payout receiver governance events in indexer output/artifacts when present

Run and verify:

```bash
scripts/staging-e2e-real-gate.sh
```

## Common failure patterns
- `RPC endpoint is unreachable`: bad RPC URL, local node not running, or network ACL.
- `INDEXER_GRAPHQL_URL is missing`: profile env not loaded.
- Address validation errors: malformed `ESCROW_ADDRESS` or `USDC_ADDRESS`.

## First 15 Minutes Checklist
- Execute `docs/incidents/first-15-minutes-checklist.md`.
- Capture reconciliation logs and identify affected `tradeId`/`requestId` pairs.
- Confirm whether failure source is RPC, indexer GraphQL, or DB.

## Rollback / backout
1. Stop daemon:

```bash
scripts/docker-services.sh down local-dev
```

2. Revert to previous env profile values.
3. Re-run one-shot reconciliation after fix.

## Escalation criteria
- Repeated CRITICAL drifts for the same trade across 3+ runs.
- On-chain read failures for >10% of trades in one run.
- Inability to reach RPC for >15 minutes.
