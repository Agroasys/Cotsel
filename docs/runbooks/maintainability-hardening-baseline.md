# Maintainability Hardening Baseline

Snapshot date: 2026-04-28

## Purpose

This document locks the Batch 0 baseline for the Cotsel maintainability and
production-readiness hardening program.

This is not a restructuring plan. The current service-oriented monorepo shape is
accepted as good enough. The program tightens the seams that become expensive in
long-lived service monorepos: contract drift, ownership ambiguity, unfinished
operational controls, fragile local startup, shared-package creep, and weak
production evidence trails.

## Scope Lock

In scope:

- Gateway-to-service contract hardening.
- Explicit ownership guidance for major repo surfaces.
- Narrow closure of materially incomplete architecture rows.
- Local/dev startup reliability.
- Shared-package boundary discipline.
- Production-sensitive evidence discipline.

Out of scope:

- Splitting the monorepo.
- Replacing the current service layout.
- Introducing a generic contract-testing platform.
- Rewriting service communication broadly.
- Creating fake governance or compliance theater.
- Claiming production truth without repo or runtime evidence.

## Current Repo Shape

Cotsel is a service-oriented monorepo. The root `package.json` defines
workspaces for `auth`, `contracts`, `gateway`, `indexer`, `oracle`, `sdk`,
`shared-http`, `shared-edge`, `shared-db`, `shared-auth`, `reconciliation`,
`notifications`, `ricardian`, and `treasury`.

The active Docker profiles run separate runtime services for `auth`, `gateway`,
`oracle`, `reconciliation`, `ricardian`, `treasury`, indexer components,
Postgres, Redis, and Hardhat for local development.

## Gateway Downstream Drift Risk

Gateway is the primary orchestration boundary. The current runtime dependencies
that can drift are:

| Boundary                    | Current dependency                                                                                                                                                                                                                        | Drift risk                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway -> auth`           | `AuthSessionClient` expects `success: true` plus `data` shaped as `AuthSession`. Capabilities and signer authorizations are consumed by gateway authorization and capability routes.                                                      | Payload shape and role/capability semantics can drift unless auth-produced fixtures are checked against gateway expectations.                                   |
| `gateway -> treasury`       | `TreasuryWorkflowService` expects a `{ success, data, error }` envelope and forwards gateway actor, ticket, reason, request, correlation, capability, and signer-policy metadata. Many route-facing returns are still typed as `unknown`. | Treasury can change field names or lifecycle semantics without a service-produced contract fixture failing gateway CI.                                          |
| `gateway -> oracle`         | `ServiceOrchestrator` generates the legacy oracle bearer plus HMAC headers and never forwards dashboard bearer auth. Oracle state progression and retry/redrive behavior remain service-owned.                                            | Auth/header drift is tested in gateway, but service-produced oracle response and redrive semantics are not yet a first-class cross-service contract fixture.    |
| `gateway -> ricardian`      | `RicardianClient` expects `/api/ricardian/v1/hash/:hash` to return `success: true` with a document record containing `hash`, `documentRef`, `requestId`, and `createdAt`; 404 remains not-found.                                          | The client validates a minimal record, but parity with ricardian controller/service output should be locked more explicitly.                                    |
| `gateway -> reconciliation` | Current gateway reconciliation reads are backed by the gateway settlement ledger, while runtime health probes target reconciliation `/health`.                                                                                            | The read model is internally tested, but health/freshness semantics and future reconciliation HTTP surfaces need explicit contract boundaries before expansion. |
| `gateway -> indexer`        | `TradeReadService` and `IndexerGraphqlClient` expect GraphQL `trades` arrays and `overviewSnapshotById` freshness fields, with strict status, timestamp, and amount parsing.                                                              | Tests cover malformed indexer payloads, but schema/fixture parity with generated indexer output should be harder to accidentally break.                         |

## Existing Contract Coverage

Strong existing coverage:

- Gateway route contract tests exist for access logs, approvals, capabilities,
  compliance, evidence bundles, governance, operations, overview,
  reconciliation, ricardian, settings, settlement, system, trades, and treasury.
- Gateway OpenAPI schema assertions are already used in route contract tests.
- `ServiceOrchestrator` tests cover correlation headers, service-auth header
  generation, read retry behavior, mutation fail-closed behavior, and timeouts.
- `TradeReadService` tests cover indexer happy paths, malformed payloads, bad
  statuses, invalid timestamps, and invalid amounts.
- Auth tests cover route mounting, sessions, admin controls, middleware, and
  rate-limit wiring.
- Treasury, oracle, ricardian, reconciliation, indexer, SDK, contracts, and
  shared packages all have service-local tests.

Weak or incomplete coverage:

- There is no single small cross-service contract fixture set proving that
  service-produced auth, treasury, oracle, ricardian, reconciliation, and
  indexer outputs still match gateway consumers.
- Some gateway clients intentionally return `unknown` for treasury reads and
  mutations, which keeps the gateway flexible but weakens compile-time drift
  detection.
- Gateway route contract tests often use fake in-process readers instead of
  exercising service-produced response fixtures.

## Ownership Baseline

No repo-level `CODEOWNERS`, `docs/owners.md`, or equivalent ownership document is
present.

Current ownership is partially implied by labels, runbooks, and matrix owner
strings such as `roadmap-maintainers`, `Ops/Platform`, `Service owner`,
`Security Owner`, `Treasury Operator`, and `Incident Commander`.

This is not enough for long-term maintainability. A new engineer can infer
component areas from folder names and issue labels, but cannot reliably answer
who should review changes to `contracts`, `gateway`, `treasury`, `oracle`,
`auth`, `ricardian`, `reconciliation`, `indexer`, `sdk`, shared packages, or
ops/release surfaces.

## Material Incomplete Rows

The active architecture coverage matrix marks these material rows incomplete:

- Embedded wallet / signer integration architecture: `In Progress`, 50%.
- Oracle trigger + approval + retry controls: `In Progress`, 70%.
- Infrastructure controls: `In Progress`, 70%.

Rows that are not immediate implementation targets:

- External buyer checkout / settlement tracker integration boundary is
  explicitly out of scope for this repo.
- Pilot lessons-learned case study is post-pilot and not a current repo
  completion gap.

## Local Startup Baseline

Current strengths:

- `scripts/docker-services.sh` provides profile-aware `build`, `up`, `down`,
  `logs`, `ps`, `health`, and `config` commands.
- `scripts/validate-env.sh` fails fast when required `.env` or profile env files
  are missing.
- `docs/runbooks/docker-profiles.md` and
  `docs/runbooks/runtime-truth-deployment-guide.md` document local and staging
  startup paths.
- Local-dev has a lightweight indexer responder and an optional
  dashboard-parity fixture mode.
- Script tests exist for docker-service args, health behavior, env layering,
  env precedence, compose rate-limit wiring, profile naming, and local-dev
  fixture behavior.

Current weakness:

- A clean checkout requires copying `.env.example` and profile examples before
  startup. That is documented, but `scripts/docker-services.sh config local-dev`
  can still render a compose config with many blank values and warnings when
  env files have not been created. `validate-env.sh` catches this, but
  `docker-services.sh` does not automatically enforce that guard before config
  rendering.
- Full Docker startup was not executed during Batch 0; this baseline records
  script and config truth only. Batch 4 must perform operational startup proof.

## Shared Package Baseline

Current shared-package posture is mostly healthy:

- `shared-auth` exports service-auth and nonce-store primitives.
- `shared-db` owns service-scoped Postgres pool/session-setting helpers.
- `shared-edge` owns CORS and rate-limit utilities.
- `shared-http` owns response envelopes and validation helpers.

No obvious business domain has moved into shared packages yet. The risk is
future creep, not current major pollution. Batch 5 should codify what belongs in
shared packages and add narrow guardrails if needed.

## Production Evidence Baseline

Existing evidence discipline:

- `docs/runbooks/operator-audit-evidence-template.md` defines audit packet
  fields for gateway governance, oracle redrive, reconciliation, treasury
  payout, and other operator workflows.
- `docs/runbooks/base-mainnet-go-no-go.md` defines required approval roles,
  evidence links, no-go conditions, and launch approval records.
- `docs/runbooks/gateway-governance-signer-custody.md` defines signer custody,
  approval, execution, rotation, break-glass, and audit minimums.
- `docs/runbooks/treasury-to-fiat-sop.md` documents treasury handoff states,
  external evidence contracts, bank confirmation evidence, and guardrails.
- `docs/runbooks/monitoring-alerting-baseline.md` defines alert evidence
  commands, severity routing, suppression policy, and incident evidence fields.

Weakness:

- Evidence templates and runbooks exist, but the repo does not yet provide one
  concise production-sensitive action index that tells operators which evidence
  packet applies to each sensitive action class.
- Some evidence expectations are spread across multiple runbooks, which raises
  the chance that production-sensitive actions rely on memory or a stale link.

## Batch Issue Map

The GitHub issue map for this program is:

- Parent program issue: `#493`
- Batch 0 issue: `#494`
- Batch 1 issue: `#495`
- Batch 2 issue: `#496`
- Batch 3 issue: `#497`
- Batch 4 issue: `#498`
- Batch 5 issue: `#499`
- Batch 6 issue: `#500`
- Batch 7 issue: `#501`

Each batch issue must include current repo truth, target state, expected
files/modules, risks, validation gates, non-goals, and observable done criteria.

## Batch 0 Acceptance State

Batch 0 is complete when:

- This baseline exists and records current repo truth.
- The GitHub issue map exists.
- No implementation code changes have begun.
- Validation proves the baseline document is formatted and the repo remains in a
  clean, reviewable state apart from this Batch 0 documentation.
