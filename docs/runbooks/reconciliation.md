# Reconciliation Runbook

## Purpose
Operate reconciliation safely in local/staging and diagnose drift failures.
For lifecycle checkpoints across lock, stage-1, and final settlement, see `docs/runbooks/hybrid-split-walkthrough.md`.
If a mismatch may be caused by routing/auth propagation/correlation breakdown between services, use `docs/runbooks/api-gateway-boundary.md` first to classify the handoff boundary before remediating reconciliation state.

Automation-governance source of truth:
- `docs/runbooks/programmability-governance.md`

Legacy chain-event ingest retirement source of truth:
- `docs/runbooks/chain-event-parity-retirement.md`

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

Generate deterministic reconciliation report from DB snapshot:

```bash
npm run -w reconciliation reconcile:report -- --run-key=<runKey> --out reports/reconciliation/latest.json
```

Notes:
- Report command reads reconciliation DB (`DB_NAME`), treasury DB (`TREASURY_DB_NAME`), and indexer DB (`INDEXER_DB_NAME`) using the same Postgres host/user/password env set.
- Output schema is stable and ordered by `tradeId`, then `txHash`; missing fields are emitted as explicit `null`.
- Treasury-linked rows now also surface `rampReference`, `fiatDepositState`, `fiatDepositFailureReason`, and `fiatDepositObservedAt` when deposit evidence exists.

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

## Audit envelope expectations
Reconciliation evidence must align with `AuditEnvelopeV1` in
`docs/observability/logging-schema.md`.

Current runtime truth:
- `reconciliation/src/utils/logger.ts` already emits `tradeId`, `actionKey`,
  `requestId`, `txHash`, `chainId`, `networkName`, and `traceId`.
- Reconciliation does not yet emit first-class `correlationId`, actor fields,
  `intent`, or `outcome` on every log line.

Operator rule:
- When reconciliation output is used for incident or treasury follow-up, attach
  missing `correlationId`, actor context, `intent`, and `outcome` from the
  nearest authoritative request ledger, gateway action, or operator evidence
  packet.
- Do not infer a terminal result from free-form text alone; record an explicit
  `outcome` in the incident or operator evidence artifact.

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

## Fiat Deposit Evidence Invariants
Treasury deposit evidence source of truth:
- `treasury/src/database/schema.sql`
- `treasury/src/database/queries.ts`
- `docs/runbooks/treasury-to-fiat-sop.md#fiat-ramp-deposit-contract`

Reconciliation report rows attach latest treasury deposit evidence per ledger entry, or the latest trade-level deposit reference when no entry-specific reference exists.

Deterministic deposit mismatch classes visible in reconciliation output:
- `MISSING_TRADE_MAPPING`
- `PARTIAL_FUNDING`
- `REVERSED_FUNDING`
- `AMOUNT_MISMATCH`
- `CURRENCY_MISMATCH`
- `STALE_PENDING_DEPOSIT`

Operator rules:
- Treat `STALE_PENDING_DEPOSIT` as a treasury operations exception even when chain-side reconciliation is otherwise clean.
- Do not mark treasury payout completion evidence as complete when `fiatDepositState` is `PENDING`, `PARTIAL`, `REVERSED`, or `FAILED`.
- When `fiatDepositFailureReason` is non-null, attach provider event identifiers and treasury approval evidence to the incident packet.

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
- Reconciliation automation must remain within the approved automation classes and rollback expectations defined in `docs/runbooks/programmability-governance.md`.

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
- reconciliation report artifact:
  - output file: `reports/reconciliation/staging-e2e-real-report.json`
- treasury payout path evidence:
  - `TreasuryClaimed` and payout receiver governance events in indexer output/artifacts when present

Run and verify:

```bash
scripts/staging-e2e-real-gate.sh
```

CI artifact name:
- `ci-report-reconciliation-report`

## Report review cadence and escalation
- Cadence:
  - review the latest reconciliation report for each staging gate run
  - perform at least one daily review while pilot operations are active
- Escalate immediately when:
  - any row has `reconciliationVerdict = "MISMATCH"` for two consecutive runs
  - mismatch reasons include `AMOUNT_MISMATCH`, `PARTICIPANT_MISMATCH`, or `HASH_MISMATCH`
  - mismatch reasons include `PARTIAL_FUNDING`, `REVERSED_FUNDING`, `CURRENCY_MISMATCH`, or `STALE_PENDING_DEPOSIT`
  - payout state is `PROCESSING` for longer than the agreed treasury operations window
- Escalation runbooks:
  - `docs/runbooks/oracle-redrive.md`
  - `docs/runbooks/treasury-to-fiat-sop.md`
  - `docs/incidents/first-15-minutes-checklist.md`

## Common failure patterns
- `RPC endpoint is unreachable`: bad RPC URL, local node not running, or network ACL.
- `INDEXER_GRAPHQL_URL is missing`: profile env not loaded.
- Address validation errors: malformed `ESCROW_ADDRESS` or `USDC_ADDRESS`.

## First 15 Minutes Checklist
- Execute `docs/incidents/first-15-minutes-checklist.md`.
- Capture reconciliation logs and identify affected `tradeId`/`requestId` pairs.
- Capture `correlationId`, `intent`, and `outcome` from the upstream gateway or
  operator evidence source when the reconciliation logger does not emit them directly.
- Confirm whether failure source is RPC, indexer GraphQL, or DB.
- Start `docs/incidents/incident-evidence-template.md` for any mismatch that requires containment or operator escalation.
- Use `docs/runbooks/operator-audit-evidence-template.md` when reconciliation output drives an operator approval or treasury follow-up.

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
