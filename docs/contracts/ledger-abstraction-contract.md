# Ledger Abstraction Contract

Canonical owners:

- `Cotsel`
- mirrored boundary document in `agroasys-backend/docs/contracts/ledger-abstraction-contract.md`

## Purpose

This document defines the Cotsel side of the Agroasys + Cotsel financial-truth
boundary.

Cotsel is not the customer accounting ledger. Cotsel normalizes settlement
execution evidence, enforces payout-eligibility controls, and supplies
reconciliation inputs that Agroasys consumes through authenticated,
replay-safe flows.

## Canonical truth boundary

### Cotsel owns execution evidence

Cotsel is canonical for settlement execution evidence such as:

- normalized chain events
- confirmation-stage observations
- reconciliation-run outputs
- payout-eligibility facts
- provider and treasury evidence required for execution closeout

### Agroasys owns accounting truth

Agroasys Aurora/Postgres and the Agroasys shadow ledger remain canonical for:

- balances
- participant-visible funds state
- finance reporting
- wallet summaries
- operator-visible remediation state

Cotsel treasury rows, reconciliation rows, and raw chain events must not be
treated as participant balance truth.

## Allowed truth propagation

1. chain event -> Cotsel normalization
2. Cotsel evidence -> authenticated Agroasys ingest
3. Agroasys reconciliation -> Agroasys control state + shadow-ledger-backed views

Forbidden shortcuts:

- chain event -> customer balance mutation
- treasury row -> accounting finalization
- callback receipt -> accounting finalization

## Freshness semantics

Current treasury enforcement defaults:

- latest completed reconciliation run must be no older than `900` seconds
- `RUNNING` reconciliation runs older than `900` seconds are stale
- stale, missing, drifted, or unknown-scope reconciliation blocks payout/export

Reprocessing, replay, and delayed correction are normal operating conditions.

## Cotsel treasury boundary

Cotsel treasury is an append-only settlement-evidence and payout-lifecycle
service. It is not a second accounting ledger for customer balances.

Treasury data may be used for:

- payout/export gating
- reconciliation evidence
- operator traceability
- provider closeout workflows

Treasury data may not be used as the direct source of participant balances or
finance reporting truth.

## Traceability requirements

Execution evidence should remain joinable to:

- Cotsel run key
- normalized trade/handoff reference
- raw transaction hash or event reference
- Agroasys handoff/order reference when available

## Related contracts

- `treasury/README.md`
- `reconciliation/README.md`
- `docs/runbooks/monitoring-alerting-baseline.md`
