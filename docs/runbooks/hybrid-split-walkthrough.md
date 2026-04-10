# Hybrid Split Walkthrough

## Purpose

Provide an operator-safe, step-by-step walkthrough of Agroasys hybrid settlement from buyer lock through stage-2 completion.

## Who This Is For

- `Operator`: runs profile checks and captures evidence.
- `On-call Engineer`: resolves runtime failures and decides escalation.
- `Treasury Operator`: validates stage-1 treasury ledger readiness.

## When To Use

- Staging/pilot validation before release promotion.
- Incident triage for settlement lifecycle failures.
- Audit evidence collection for completed settlements.

## Scope

- Buyer lock into escrow (`createTrade`) and milestone-based releases.
- On-chain and off-chain verification checkpoints.
- Failure handling for indexer/oracle/reconciliation paths.

## Non-Scope

- Contract upgrades, admin governance, or key rotation procedures.
- Manual custody or direct wallet payout operations outside approved services.
- Frontend checkout UX implementation details.

## Prerequisites

- Environment initialized from repo examples:

```bash
cp .env.example .env
cp .env.staging-e2e-real.example .env.staging-e2e-real
scripts/validate-env.sh staging-e2e-real
```

- Required services healthy:

```bash
scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
```

- Contract addresses for escrow/USDC/indexer are set consistently across `.env` and `.env.staging-e2e-real`.
- Oracle and reconciliation RPC/indexer URLs target the same chain dataset.

## Hybrid Model Summary (On-Chain vs Off-Chain)

- On-chain:
  - Escrow contract state and events (`TradeLocked`, `FundsReleasedStage1`, `PlatformFeesPaidStage1`, `FinalTrancheReleased`).
  - Immutable `ricardianHash` anchoring the legal agreement.
- Off-chain:
  - Document and logistics verification inputs handled by operator/oracle processes.
  - Reconciliation run results, drift diagnostics, and treasury payout lifecycle evidence.

## Procedure

### 1. Pre-flight system check

Run baseline readiness:

```bash
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
```

Expected result:

- Health checks pass for `oracle`, `reconciliation`, `treasury`, `indexer-graphql`, and dependencies.
- Gate prints reconciliation summary and drift snapshot.

If not:

- Run `docs/incidents/first-15-minutes-checklist.md`.
- Collect logs:

```bash
scripts/docker-services.sh logs staging-e2e-real oracle
scripts/docker-services.sh logs staging-e2e-real reconciliation
scripts/docker-services.sh logs staging-e2e-real indexer-graphql
```

### 2. Buyer lock (escrow encumbrance)

Trigger trade creation through approved checkout/backend flow that calls `createTrade`.

Expected result:

- On-chain trade enters `LOCKED`.
- Indexer exposes the trade with a non-empty `ricardianHash`.
- `TradeLocked` appears in event history.

Verification sample:

```bash
curl -fsS "http://127.0.0.1:${INDEXER_GRAPHQL_PORT:-4350}/graphql" \
  -H 'content-type: application/json' \
  --data '{"query":"query { trades(limit: 5) { tradeId status ricardianHash createdAt } }"}'
```

If not:

- Confirm escrow address and indexer contract address alignment in env files.
- Confirm indexer head is advancing using `scripts/staging-e2e-real-gate.sh`.
- Do not proceed to release steps until `TradeLocked` visibility is restored.

### 3. Stage-1 release (oracle-triggered)

Stage-1 is executed only through oracle-controlled release flow (`releaseFundsStage1` path).

Expected result:

- Trade status transitions to `IN_TRANSIT`.
- `FundsReleasedStage1` and `PlatformFeesPaidStage1` events are indexed.
- Treasury ingest path can materialize corresponding ledger entries.

Verification sample:

```bash
curl -fsS "http://127.0.0.1:${INDEXER_GRAPHQL_PORT:-4350}/graphql" \
  -H 'content-type: application/json' \
  --data '{"query":"query { tradeEvents(limit: 20) { trade { tradeId } eventName txHash blockNumber } }"}'
```

If not:

- Follow `docs/runbooks/oracle-redrive.md` for bounded retry/redrive.
- Verify reconciliation and indexer remain healthy before any manual redrive attempt.

### 4. Reconciliation and treasury verification after stage-1

Validate that off-chain mirrors are consistent before any treasury payout action.

```bash
npm run -w reconciliation reconcile:once
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/entries?limit=50&offset=0"
```

Expected result:

- Reconciliation run completes without unresolved CRITICAL drift.
- Treasury entries exist for stage-1 components with valid lifecycle state (`PENDING_REVIEW` or later).

If not:

- Pause payout progression for affected trade IDs.
- Investigate drift and run-level evidence in `docs/runbooks/reconciliation.md`.

### 5. Stage-2 release (final settlement)

After arrival is confirmed and the dispute window elapses without an active dispute, final settlement is executed via `finalizeAfterDisputeWindow` (permissionless on-chain closeout).

Expected result:

- Trade reaches final settlement state (`CLOSED` in indexed trade status).
- `FinalTrancheReleased` is visible on indexer timeline.
- Reconciliation confirms on-chain/off-chain parity for the settlement.

If not:

- Treat as settlement-blocking incident and escalate through on-call path.
- Use approved fallback run procedure for permissionless finalization after dispute-window checks.

### 6. Settlement closeout evidence

Capture and attach:

- `tradeId`, `txHash` values for lock/stage-1/stage-2 events.
- Reconciliation run summary and drift snapshot.
- Treasury ledger entry IDs and final payout states (if applicable).
- Any incident ticket IDs and operator notes for exceptions.

## Failure Handling Decision Guide

### Indexer unavailable or stale

- Signal: GraphQL readiness fails or head lag breaches threshold.
- Action:
  - Restart profile from clean state.
  - Re-run `scripts/staging-e2e-real-gate.sh`.
  - Escalate if lag remains above threshold or chain mismatch is detected.

### Oracle trigger fails or exhausts retries

- Signal: trigger status `EXHAUSTED_NEEDS_REDRIVE` or `TERMINAL_FAILURE`.
- Action:
  - Use `docs/runbooks/oracle-redrive.md`.
  - Allow only one controlled redrive after truth-source checks.
  - Escalate on repeated exhaustion for the same `actionKey`.

### Reconciliation mismatch

- Signal: recurring CRITICAL mismatch codes for the same trade across runs.
- Action:
  - Stop risky automation for affected trade.
  - Gather reconciliation logs and mismatch evidence.
  - Escalate to on-call engineer/service owner.

### Settlement stuck on timeout

- Signal: dispute window elapsed but final settlement is not confirmed on-chain/indexer.
- Action:
  - Validate indexer/reconciliation/on-chain consistency.
  - Use the permissionless finalization fallback path (`finalizeAfterDisputeWindow`) if preconditions are satisfied.
  - If unresolved, pause further settlement actions and escalate.

## Safety Guardrails

- Do not execute manual stage-1 release outside approved oracle/service workflow.
- Do not execute stage-2 fallback before dispute-window and trade-state preconditions are satisfied.
- Do not change escrow/USDC/indexer contract addresses mid-flight for active trades.
- Do not bypass reconciliation checks when drift evidence is unresolved.
- Do not disable verification controls without incident approval and audit record.

## Evidence To Record

- Environment profile and timestamp.
- Commands executed and key outputs (`health`, gate summary, reconciliation summary).
- Trade-level identifiers (`tradeId`, `requestId`, `actionKey`, `txHash` where available).
- Decision notes for any retry/redrive/escalation.

## Rollback / Escalation

1. Freeze risky automation for impacted trades.
2. Run `docs/incidents/first-15-minutes-checklist.md`.
3. Capture oracle/reconciliation/indexer logs and reconciliation run output.
4. Escalate with evidence bundle to on-call engineer and service owner.

## Related Runbooks

- `docs/runbooks/reconciliation.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
