# Maintainability Hardening Review And Remediation

Snapshot date: 2026-04-28

## Purpose

Record the skeptical review of the initial hardening pass and the remediation
applied afterward. This file exists because the first closeout overstated some
completion: several batches were useful but leaned too heavily on documentation
and did not reduce enough code-level coupling.

## Batch A Findings

Mostly real:

- Batch 0 captured a useful baseline and issue map.
- Batch 4 made a real runtime improvement by preflighting Docker profile envs.
- Batch 6 created a useful evidence index.

Too shallow before remediation:

- Batch 1 only hardened auth session shape; treasury mutation success payloads
  could still drift to non-record data.
- Batch 2 had an ownership map, but lacked a quick review-routing guide.
- Batch 3 appended a matrix note, but row metadata still carried old evidence
  and refresh dates.
- Batch 5 only blocked imports; a shared package could still declare a service
  package dependency in `package.json`.
- The shared-package guard was initially scoped to the current four
  `shared-*` package names, which meant a future `shared-*` package could bypass
  the guard entirely.
- Batch 7 did not address the oversized governance mutation router or the
  gateway settlement store mixing production Postgres persistence with the
  in-memory test adapter.
- Issues `#494` through `#501` were labeled `status:done` while the branch was
  still local and uncommitted. That label state overstated review readiness, so
  the issues were moved back to `status:in-progress` until the branch is
  committed or opened for review.

## Structural Review Findings

Files that remain large by design or current risk level:

- `sdk/src/types/typechain-types/**`: generated TypeChain output; not a manual
  maintainability target.
- `treasury/src/database/queries.ts`: large data-access module. It is still a
  real future split candidate, but this pass did not move SQL functions because
  the safest boundary needs service-owner review around migrations and
  transaction behavior.
- `treasury/src/api/controller.ts`: large controller, but below the highest-risk
  threshold after review. Validation helpers are concentrated near the top and
  money-movement state rules already live in `treasury/src/core/*`; splitting it
  further should happen with treasury-owner review rather than as a mechanical
  churn change.
- `indexer/src/main.ts`: large event-handler module. It should eventually split
  event handler families, but it couples to Subsquid processor state and was not
  changed in this pass to avoid accidental indexing regressions.
- `gateway/src/core/settlementStore.ts`: still large after remediation because
  it owns the Postgres settlement store contract, row mappers, and SQL
  persistence. The in-memory adapter was the unsafe mixed responsibility and was
  extracted; a further SQL split should happen only if settlement persistence
  becomes an active review bottleneck.
- `gateway/src/core/governanceMutationService.ts`: still large, but now mostly
  cohesive around governance action persistence, direct-sign payload creation,
  and broadcast verification. The route wiring was the higher-risk coupling and
  was extracted first; a later payload/verifier split is a possible
  owner-reviewed cleanup, not required for this pass.

Remediated now:

- `gateway/src/routes/governanceMutations.ts` mixed retired queue routes, active
  direct-sign routes, signer validation helpers, and response helpers. Active
  direct-sign prepare/confirm routes now live in
  `gateway/src/routes/governanceDirectSignMutations.ts`, with shared route
  helpers in `gateway/src/routes/governanceMutationRouteSupport.ts`.
- `gateway/src/core/settlementStore.ts` mixed production Postgres persistence
  with the in-memory adapter used by gateway route/read-service tests. The
  in-memory adapter now lives in
  `gateway/src/core/inMemorySettlementStore.ts` and is re-exported through the
  existing settlement store module so current callers do not need churn.
- `scripts/shared-package-boundary-guard.mjs` now discovers every top-level
  `shared-*` directory instead of checking only the four current package names.
  Its focused test includes a synthetic future `shared-risk` package to prove
  new shared packages are covered.

## Contract Review Findings

The auth session client now validates required gateway authority fields and
normalizes invalid JSON to a gateway upstream error. Treasury mutations now
require successful `data` payloads to be records before audit logging and
returning them to callers.

Known remaining limitation:

- The repo still does not have a broad cross-service fixture harness, by design.
  Coverage remains focused on gateway consumer behavior and service-local tests.

## Operational Truth Corrections

- Architecture matrix rows for signer/wallet, oracle redrive, and
  infrastructure controls now carry refreshed evidence and dates instead of only
  a separate note.
- Oracle redrive remains `In Progress`, not `Done`, because live/operator
  redrive evidence is not in repo truth.
- Infrastructure controls remain `In Progress` until the new hardening guards
  are adopted into normal release/review gates.

## Non-Goals Preserved

- No repo split.
- No generic contract-testing framework.
- No new orchestration framework.
- No fake `CODEOWNERS`.
- No broad SQL/indexer refactor without a safer service-owner slice.
