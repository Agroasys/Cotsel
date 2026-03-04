# Architecture Coverage Matrix

Snapshot date: 2026-03-01

Scope:
- Source of truth is repository code, merged/open PRs, and roadmap issues.
- Third-party KYC/KYB/AML vendor internals are excluded, but integration boundaries are tracked.
- External pilot execution deliverables are excluded from repo completion scoring: legal consultation/memo delivery, live KPI report execution, and live community demo production.

Status legend:
- `Done`: acceptance criteria implemented and evidenced in repo/CI.
- `In Progress`: partial implementation with measurable gaps.
- `Blocked`: depends on missing in-repo surface or external dependency.
- `Backlog`: not started.
- `Out of Scope`: intentionally tracked but excluded from repo completion scoring.

Production readiness checklist:
- `docs/runbooks/production-readiness-checklist.md`

## Component Mapping

Row metadata semantics:
- `Owner`: maintainer group responsible for row freshness/evidence upkeep.
- `Last Refreshed`: last date the row evidence/status was validated.
- `Refresh Cadence`: expected review frequency for row maintenance.

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Escrow lifecycle + split-settlement safety | A | Done | 100 | #42, #54 | `contracts/tests/AgroasysEscrow.ts`, `contracts/foundry/test/AgroasysEscrowFuzz.t.sol`, PR #8, PR #13, CI run 22197616358 (`ci/contracts` success) | None for milestone-A baseline | roadmap-maintainers | 2026-02-28 | weekly |
| Pull-over-push claim settlement model (design + implementation) | B | Done | 100 | #142, #150, #153 | `docs/adr/adr-0142-pull-over-push-claim-settlement.md`, `docs/runbooks/pull-over-push-claim-flow.md`, `contracts/src/AgroasysEscrow.sol` (`claimableUsdc`, `claim`, `pauseClaims`, `unpauseClaims`), `contracts/tests/AgroasysEscrow.ts`, PR #151, PR #154, PR #165, PR #166, PR #167, PR #168, CI run 22518631770 (`ci/contracts` success), CI run 22518757426 (`ci/contracts` success) | None for issue-#142 design + implementation scope | roadmap-maintainers | 2026-02-28 | weekly |
| Ricardian PDF/hash service | A | In Progress | 75 | #43, #132 | `ricardian/src/utils/hash.ts`, `ricardian/src/utils/canonicalize.ts`, `ricardian/tests/canonicalize.test.ts`, `sdk/src/modules/ricardianClient.ts`, PR #21 | DocumentStore retrieval resiliency and legal-evidence availability hardening still pending | roadmap-maintainers | 2026-02-28 | weekly |
| Indexer pipeline + GraphQL schema correctness | A/B | Done | 100 | #44, #174 | `indexer/src/main.ts` (tx/extrinsic separation), `indexer/schema.graphql` (`txHash`, `extrinsicHash` indexed fields), `indexer/src/model/generated/tradeEvent.model.ts`, `indexer/db/migrations/1771180205323-Data.js`, PR #23, PR #177 | None for issue-#44 and issue-#174 scope | roadmap-maintainers | 2026-02-28 | weekly |
| Reconciliation drift remediation | A/B | Done | 100 | #45, #53 | `reconciliation/src/core/classifier.ts`, `reconciliation/src/core/reconciler.ts`, `reconciliation/src/core/reconciliationReport.ts`, `reconciliation/src/tests/classifier-address-validation.test.ts`, `reconciliation/src/tests/reconciliation-report.test.ts`, `scripts/staging-e2e-real-gate.sh`, PR #182 | None for issue-#45 and issue-#53 scope | roadmap-maintainers | 2026-03-01 | weekly |
| SDK typed modules + ABI parity | A | Done | 100 | #46, #50 | `sdk/src/modules/`, `sdk/tests/abiAlignment.test.ts`, `sdk/README.md`, PR #12, PR #15, CI run 22197616358 (`ci/sdk` success) | None for issue-#46 scope (checkout integration tracked in #50) | roadmap-maintainers | 2026-02-28 | weekly |
| Release gates + profile health determinism | A/B | In Progress | 75 | #47, #55, #71 | `scripts/docker-services.sh`, `scripts/staging-e2e-gate.sh`, `scripts/tests/docker-services-args.test.sh`, PR #28, PR #39, PR #41 (open) | Staging-real gate promotion and full CI enforcement are not complete | roadmap-maintainers | 2026-02-28 | weekly |
| Core docs + runbooks + developer guidance | A | Done | 100 | #49, #65, #172 | `README.md`, `docs/docker-services.md`, `docs/runbooks/staging-e2e-release-gate.md`, `docs/runbooks/production-readiness-checklist.md`, `docs/runbooks/pull-over-push-claim-flow.md`, `docs/runbooks/treasury-to-fiat-sop.md`, `docs/runbooks/reconciliation.md`, PR #31, PR #34, PR #178 | None for issue-#49, issue-#65, and issue-#172 scope | roadmap-maintainers | 2026-02-28 | weekly |
| Dashboard + unified checkout + settlement tracker | B | Blocked | 25 | #50, #129 | SDK support exists (`sdk/src/modules/`, `sdk/README.md`), Web3Auth dependency present | No in-repo dashboard surface; cross-repo dependency governance still required for closure | roadmap-maintainers | 2026-02-28 | weekly |
| Identity service + user profile persistence | B | Done | 100 | #122 | `auth/`, `auth/src/core/sessionService.ts`, `auth/src/database/schema.sql`, `sdk/src/modules/authClient.ts`, PR #197 | None for issue-#122 scope | roadmap-maintainers | 2026-03-01 | weekly |
| Web3Auth signing/session architecture | B | In Progress | 50 | #50, #122, #105 | `sdk/README.md` Web3Auth section, `@web3auth/modal` in `sdk/package.json`, PR #15 | Full frontend/session lifecycle and operational runbook still missing | roadmap-maintainers | 2026-02-28 | weekly |
| Oracle trigger + approval + retry controls | B/C | In Progress | 70 | #51, #56, #61, #124 | `oracle/src/core/trigger-manager.ts`, `oracle/src/worker/confirmation-worker.ts`, `oracle/src/api/routes.ts`, `docs/runbooks/oracle-redrive.md`, PR #14 | Pilot manual-approval mode and complete SOP hardening still open | roadmap-maintainers | 2026-02-28 | weekly |
| Treasury payout queue + audit traceability | B/C | Blocked | 40 | #52, #67, #126, #127 | `treasury/src/database/schema.sql`, `treasury/src/database/queries.ts`, `treasury/src/core/payout.ts`, PR #22 | Processing/audit workflow requires missing operator UI/workflow integration and bank/fiat boundary finalization | roadmap-maintainers | 2026-02-28 | weekly |
| Reconciliation reports (on-chain ↔ fiat evidence) | B | Done | 100 | #53 | `reconciliation/src/report-cli.ts`, `reconciliation/src/core/reconciliationReport.ts`, `reconciliation/src/tests/reconciliation-report.test.ts`, `scripts/staging-e2e-real-gate.sh`, `.github/workflows/release-gate.yml` (`ci-report-reconciliation-report`), `docs/runbooks/reconciliation.md`, PR #182 | None for issue-#53 scope | roadmap-maintainers | 2026-03-01 | weekly |
| AssetHub assets + USDC fee conversion validation | A | In Progress | 60 | #63 | `scripts/asset-fee-path-gate.sh`, `scripts/asset-fee-path-validate.mjs`, `scripts/tests/asset-fee-path-gate.test.sh`, `docs/runbooks/asset-conversion-fee-validation.md`, `.github/workflows/release-gate.yml` (`ci/asset-fee-path`) | Live staging tx reference set for `usdc-preferred` mode still needs operator-supplied tx hashes/evidence | roadmap-maintainers | 2026-02-28 | weekly |
| PolkaVM deployment verification + smoke checks | A | Done | 100 | #64 | `scripts/polkavm-deploy-verify.mjs`, `.github/workflows/release-gate.yml` (`ci/contracts-deploy-verification`), `docs/runbooks/polkavm-deploy-verification.md`, PR #141 (merged), CI run 22491206400 (`ci/contracts-deploy-verification` success + artifact), CI run 22492497423 (`bytecodeHashMatch=true` with real artifact path in `ci-report-contracts-deploy-verification`) | None for issue-#64 scope | roadmap-maintainers | 2026-02-28 | weekly |
| Mainnet pilot execution evidence | B | Backlog | 0 | #66 | None in repo yet | No transaction evidence package or pilot proof artifacts | roadmap-maintainers | 2026-02-28 | weekly |
| Hybrid split walkthrough + treasury-to-fiat SOP | B | Done | 100 | #67 | `docs/runbooks/hybrid-split-walkthrough.md`, `docs/runbooks/treasury-to-fiat-sop.md`, `README.md` runbook links | None for issue-#67 scope | roadmap-maintainers | 2026-02-28 | weekly |
| Pilot documentation package (env + legal/KPI/demo templates + user guide) | C | Done | 100 | #57, #58, #59, #60, #68 | `docs/runbooks/pilot-environment-onboarding.md`, `docs/runbooks/staging-e2e-real-release-gate.md`, `docs/runbooks/pilot-kpi-report-template.md`, `docs/runbooks/demo/community-demo-checklist.md`, `docs/runbooks/demo/community-demo-script.md`, `docs/runbooks/non-custodial-pilot-user-guide.md`, `docs/runbooks/legal-evidence-package-template.md` | None for documentation scope deliverables in repo | roadmap-maintainers | 2026-02-28 | weekly |
| Pilot lessons-learned case study (post-live execution) | Post-C | Out of Scope | 0 | #69 | None in repo yet | Deferred until real pilot execution evidence exists | roadmap-maintainers | 2026-02-28 | weekly |
| Infrastructure controls (CI/CD, roadmap governance, release controls) | A/B/C | In Progress | 70 | #70, #71, #72, #73, #100, #104, #125, #131 | `.github/workflows/ci.yml`, `.github/workflows/pr-roadmap-policy.yml`, `docs/runbooks/github-roadmap-governance.md`, PR #62, PR #76 | Coverage matrix + gate linkage exists, but monitoring baseline, dependency major-upgrade backlog, and consistency enforcement are still open | roadmap-maintainers | 2026-02-28 | weekly |
| Primary DB operations + recovery evidence | C | Done | 100 | #133 | `scripts/postgres-backup-restore-smoke.sh`, `docs/runbooks/postgres-backup-restore-recovery.md`, `docs/runbooks/production-readiness-checklist.md`, `.github/workflows/release-gate.yml` (`ci-report-postgres-recovery-smoke`), PR #183 | None for issue-#133 scope | roadmap-maintainers | 2026-03-01 | weekly |
| Notifications service behavior + operational controls | A/B | Done | 100 | #77, #130 | `notifications/src/`, `notifications/tests/`, `scripts/notifications-wiring-health.sh`, `scripts/notifications-gate.sh`, `scripts/notifications-gate-validate.mjs`, `.github/workflows/release-gate.yml` (`ci-report-notifications-gate`) | None for issue-#130 scope | roadmap-maintainers | 2026-02-28 | weekly |
| API gateway orchestration + error handoff boundary | A/B | Backlog | 0 | #78, #123, #124 | Architectural requirement documented in `web3layer.mmd`; no dedicated in-repo service boundary document | Define and implement runtime gateway and error-handler control plane | roadmap-maintainers | 2026-02-28 | weekly |
| Compliance boundary policy contract (KYB/KYT/Sanctions) | C | Done | 100 | #128 | `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`, `docs/runbooks/production-readiness-checklist.md` (Compliance boundary governance section), decision record #200 | None for issue-#128 policy documentation and governance-contract scope; provider runtime integration is tracked separately from this row | roadmap-maintainers | 2026-03-04 | weekly |

## Milestone Rollup (evidence-based)

_Maintenance note: milestone rollup percentages are manually recomputed using the formula below; update these values whenever roadmap issue `% Complete` values or component statuses change._
- Milestone A: 52% (snapshot as of 2026-03-01; derived via formula below)
- Milestone B: 23% (snapshot as of 2026-03-01; derived via formula below)
- Milestone C: 0% (snapshot as of 2026-03-01; derived via formula below)

Computation method:
- Scope: for each milestone, take all non-gate roadmap issues linked from the corresponding Component Mapping rows that are not marked `Out of Scope`, explicitly excluding milestone gate issues (#70/#71/#72).
- Out-of-scope handling: rows with status `Out of Scope` and any issues referenced only from those rows are excluded from repo completion scoring and from the milestone rollup arithmetic mean.
- Authoritative signal: use roadmap issue `% Complete` values as per-deliverable completion.
- Formula: milestone completion = arithmetic mean of in-scope issue `% Complete` values (excluding milestone gate issues #70/#71/#72), rounded to nearest whole percent.
- Deduplication rule: if an issue appears in multiple rows for the same milestone, count it once.
- Recompute after each in-scope issue status or `% Complete` change.
- Milestone gate issues (#70/#71/#72) track the rollup value and, as described above, are excluded from the average.

## Gate-to-Row Mapping

- Gate `#70` (Milestone A) maps to:
  - Escrow lifecycle + split-settlement safety
  - Ricardian PDF/hash service
  - Indexer pipeline + GraphQL schema correctness
  - Reconciliation drift remediation
  - SDK typed modules + ABI parity
  - Release gates + profile health determinism
  - Core docs + runbooks + developer guidance
  - AssetHub assets + USDC fee conversion validation
  - PolkaVM deployment verification + smoke checks
- Gate `#71` (Milestone B) maps to:
  - Dashboard + unified checkout + settlement tracker
  - Identity service + user profile persistence
  - Web3Auth signing/session architecture
  - Oracle trigger + approval + retry controls
  - Treasury payout queue + audit traceability
  - Reconciliation reports (on-chain ↔ fiat evidence)
  - Mainnet pilot execution evidence
  - Hybrid split walkthrough + treasury-to-fiat SOP
  - API gateway orchestration + error handoff boundary
  - Notifications service behavior + operational controls
- Gate `#72` (Milestone C) maps to:
  - Pilot documentation package (env + legal/KPI/demo templates + user guide)
  - Oracle trigger + approval + retry controls (pilot-safe mode)
  - Treasury payout queue + audit traceability (pilot operations)
  - Infrastructure controls (CI/CD, roadmap governance, release controls)
  - Primary DB operations + recovery evidence
  - Compliance boundary policy contract (KYB/KYT/Sanctions)

## Maintenance Rule

Before marking any milestone gate `Done`:
1. Ensure each related row above is either `Done` or explicitly `Out of Scope`, with approval recorded in the corresponding gate issue or roadmap item.
2. Ensure each `Done` row references concrete repo evidence (files, tests, merged PRs, CI run).
3. Update gate issue body `% Complete` and project field `% Complete` in the same change.
 4. Recompute and update the "Milestone Rollup" percentages above whenever any in-scope issue `% Complete` value changes (or verify that roadmap rollup automation has done so).
