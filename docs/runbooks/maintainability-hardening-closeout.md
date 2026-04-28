# Maintainability Hardening Closeout

Snapshot date: 2026-04-28

## Purpose

Close the maintainability hardening program as one coherent pass. This program
did not restructure Cotsel. It tightened service contracts, ownership,
operational gap tracking, local startup, shared-package boundaries, and
production evidence discipline inside the existing service-oriented monorepo.

Follow-up review and remediation are recorded in
`docs/runbooks/maintainability-hardening-review-remediation.md`.

## Batch Results

| Batch   | Result                                                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch 0 | Baseline audit and issue map created in `docs/runbooks/maintainability-hardening-baseline.md` and GitHub issues `#493` through `#501`.                                                                                                                     |
| Batch 1 | Gateway auth session contract now fails closed on malformed authority shape and invalid JSON; treasury mutation responses must return record-shaped `data` before audit/return.                                                                            |
| Batch 2 | Ownership is explicit in `docs/owners.md` with a review-routing cheat sheet and without fake `CODEOWNERS` handles.                                                                                                                                         |
| Batch 3 | Material incomplete architecture rows are narrowed truthfully; matrix row evidence/dates were refreshed and oracle redrive runbook controls have a guard.                                                                                                  |
| Batch 4 | Docker startup/config actions now run env preflight before Compose interpolation can produce blank values, with actionable missing-env copy hints.                                                                                                         |
| Batch 5 | Shared packages have a documented boundary standard and a guard that discovers every top-level `shared-*` package and blocks service-domain imports or manifest dependencies.                                                                              |
| Batch 6 | Production-sensitive action classes now map to required runbooks, approvers, evidence packets, and a minimal evidence record.                                                                                                                              |
| Batch 7 | Targeted validations were rerun together, the oversized governance mutation router was split by real direct-sign boundary, the settlement in-memory adapter was separated from the Postgres store, and the final scope remains hardening, not restructure. |

## What Is Intentionally Not Changed

- No service was moved or split out of the monorepo.
- No generic contract-testing platform was introduced.
- No new workflow engine was added for oracle redrive or production evidence.
- No fake `CODEOWNERS` file was added without confirmed GitHub handles.
- No shared package was rewritten for aesthetics.
- No SQL/indexer mega-refactor was attempted without a safer owner-reviewed
  slice.
- No remote issue was left labeled as fully complete before branch review;
  issues `#494` through `#501` are `status:in-progress` while this local branch
  remains uncommitted.

## Remaining Non-Blocking Backlog

- Confirm real GitHub user/team handles before adding `CODEOWNERS`.
- Keep embedded wallet/signer sequencing rows open until issues `#122` and
  `#105` have linked implementation and test evidence.
- Keep infrastructure controls marked `In Progress` until these hardening
  checks are adopted into the regular release gate or review checklist.
- Attach live production or rehearsal evidence to the evidence index when real
  production-sensitive actions occur.
- Split `treasury/src/database/queries.ts` and `indexer/src/main.ts` in future
  owner-reviewed slices if they become active review bottlenecks.

## Current Truth After This Pass

Cotsel remains a service-oriented monorepo. The repo is now harder to drift
silently because gateway auth authority shape is validated, treasury mutation
payloads are shape-checked, owners are visible, startup preflight fails earlier,
shared-package creep has a guard, sensitive production actions have one evidence
index, active governance direct-sign routes are separated from retired queue
route compatibility, and gateway settlement tests no longer live inside the
production Postgres store implementation.
