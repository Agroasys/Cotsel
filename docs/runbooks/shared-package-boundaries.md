# Shared Package Boundaries

Snapshot date: 2026-04-28

## Purpose

Keep `shared-*` packages boring, stable, and boundary-focused. Shared packages
are allowed to hold reusable primitives, but they must not become hidden service
domains or places where business workflows are moved to avoid clear ownership.

## Current Shared Packages

| Package       | Role                                                                          | Boundary status |
| ------------- | ----------------------------------------------------------------------------- | --------------- |
| `shared-auth` | Service-to-service authentication canonical strings, signatures, nonce stores | Healthy         |
| `shared-db`   | Service-scoped Postgres pool and session-setting helpers                      | Healthy         |
| `shared-edge` | HTTP edge helpers such as CORS and rate limiting                              | Healthy         |
| `shared-http` | Response envelopes and request validation primitives                          | Healthy         |

## What Belongs In Shared Packages

- Stable protocol or HTTP primitives used by multiple services.
- Boundary schemas or validation helpers that do not decide service workflow
  state.
- Infrastructure helpers that are parameterized by the consuming service.
- Small utilities where ownership and behavior are obvious from the package
  name.

## What Does Not Belong In Shared Packages

- Treasury payout, handoff, or accounting state machines.
- Oracle trigger, retry, redrive, or approval decisions.
- Auth profile/session lifecycle decisions.
- Gateway orchestration logic.
- Reconciliation classification or remediation decisions.
- Indexer read-model construction.
- Ricardian document business rules beyond reusable canonicalization/hash
  primitives that are explicitly shared.
- SDK client workflows that belong in `sdk/`.

## Guardrail

`scripts/shared-package-boundary-guard.mjs` discovers every top-level
`shared-*` directory and fails when one imports, requires, or declares a
manifest dependency on a service workspace such as
`gateway`, `treasury`, `oracle`, `auth`, `ricardian`, `reconciliation`,
`indexer`, `sdk`, `notifications`, or `contracts`.

This is intentionally a small guard. It prevents the most damaging shared-package
creep without banning legitimate shared primitives.

## Review Rule

Any PR changing a `shared-*` package must explain:

- which services consume the change
- why the behavior belongs in shared code
- which service-specific behavior was intentionally kept out
- which package tests or boundary guard were run

## Non-Goals

- No purity rewrite.
- No forced movement of healthy shared code.
- No new shared package unless the ownership and consumer contract are clear.
