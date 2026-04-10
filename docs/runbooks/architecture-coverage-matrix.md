# Architecture Coverage Matrix

Snapshot date: 2026-04-01

Active-usage note:
- This matrix is the active architecture traceability surface for the Base-era repo.
- The authoritative migration/governance closeout lives in issue `#339`, milestones `M0` through `M5`, the active Base runbooks, and the merged Base migration PR history.
- Historical Polkadot/PolkaVM rows remain here only where they still provide audit traceability. They are explicitly marked `archive-only` and are not active v1 truth.
- Do not use this matrix to override M4 pilot evidence, M5 go/no-go controls, or active Base incident/runbook decisions.

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
- `Refresh Cadence`: expected review frequency for row maintenance. Use `archive-only` when the row is preserved purely as historical evidence after retirement.

| Component | Program Scope | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Escrow lifecycle + split-settlement safety | Base active | Done | 100 | #42, #54 | `contracts/tests/AgroasysEscrow.ts`, `contracts/foundry/test/AgroasysEscrowFuzz.t.sol`, PR #8, PR #13, CI run 22197616358 (`ci/contracts` success) | None for current Base-era escrow scope | roadmap-maintainers | 2026-04-01 | weekly |
| Pull-over-push claim settlement model (design + implementation) | Base active | Done | 100 | #142, #150, #153 | `docs/adr/adr-0142-pull-over-push-claim-settlement.md`, `docs/runbooks/pull-over-push-claim-flow.md`, `contracts/src/AgroasysEscrow.sol` (`claimableUsdc`, `claim`, `pauseClaims`, `unpauseClaims`), `contracts/tests/AgroasysEscrow.ts`, PR #151, PR #154, PR #165, PR #166, PR #167, PR #168, CI run 22518631770 (`ci/contracts` success), CI run 22518757426 (`ci/contracts` success) | None for issue-#142 design + implementation scope | roadmap-maintainers | 2026-04-01 | weekly |
| Ricardian PDF/hash service | Base active | Done | 100 | #43, #132 | `ricardian/src/utils/hash.ts`, `ricardian/src/utils/canonicalize.ts`, `ricardian/tests/canonicalize.test.ts`, `sdk/src/modules/ricardianClient.ts`, `ricardian/src/database/documentStore.ts`, `ricardian/tests/documentStore.test.ts`, PR #21, PR #256 | None for issue-#43 and issue-#132 scope | roadmap-maintainers | 2026-04-01 | weekly |
| Indexer pipeline + GraphQL schema correctness | Base active | Done | 100 | #44, #174 | `indexer/src/main.ts` (Base tx/log identity), `indexer/schema.graphql` (`txHash` active; legacy extrinsic fields retained only for historical compatibility), `indexer/src/model/generated/tradeEvent.model.ts`, `indexer/db/migrations/1771180205323-Data.js`, PR #23, PR #177 | None for issue-#44 and issue-#174 scope | roadmap-maintainers | 2026-04-01 | weekly |
| Reconciliation drift remediation | Base active | Done | 100 | #45, #53 | `reconciliation/src/core/classifier.ts`, `reconciliation/src/core/reconciler.ts`, `reconciliation/src/core/reconciliationReport.ts`, `reconciliation/src/tests/classifier-address-validation.test.ts`, `reconciliation/src/tests/reconciliation-report.test.ts`, `scripts/staging-e2e-real-gate.sh`, PR #182 | None for issue-#45 and issue-#53 scope | roadmap-maintainers | 2026-04-01 | weekly |
| SDK typed modules + ABI parity | Base active | Done | 100 | #46, #50 | `sdk/src/modules/`, `sdk/tests/abiAlignment.test.ts`, `sdk/README.md`, PR #12, PR #15, CI run 22197616358 (`ci/sdk` success) | None for issue-#46 scope (checkout integration tracked in #50) | roadmap-maintainers | 2026-04-01 | weekly |
| Release gates + profile health determinism | Base active | Done | 100 | #47, #55, #71 | `scripts/docker-services.sh`, `scripts/staging-e2e-gate.sh`, `scripts/tests/docker-services-args.test.sh`, PR #28, PR #39, PR #41 (open) | None for current Base release-gate scope | roadmap-maintainers | 2026-04-01 | weekly |
| Core docs + runbooks + developer guidance | Base active | Done | 100 | #49, #65, #172 | `README.md`, `docs/docker-services.md`, `docs/runbooks/staging-e2e-release-gate.md`, `docs/runbooks/production-readiness-checklist.md`, `docs/runbooks/pull-over-push-claim-flow.md`, `docs/runbooks/treasury-to-fiat-sop.md`, `docs/runbooks/reconciliation.md`, PR #31, PR #34, PR #178 | None for issue-#49, issue-#65, and issue-#172 scope | roadmap-maintainers | 2026-04-01 | weekly |
| Dashboard + unified checkout + settlement tracker | External dependency | Blocked | 25 | #50, #129 | SDK support exists (`sdk/src/modules/`, `sdk/README.md`), legacy browser wallet-provider dependency still present in compatibility flows | No in-repo dashboard surface; cross-repo dependency governance still required for closure | roadmap-maintainers | 2026-04-01 | weekly |
| Identity service + user profile persistence | Base active | Done | 100 | #122 | `auth/`, `auth/src/core/sessionService.ts`, `auth/src/database/schema.sql`, `sdk/src/modules/authClient.ts`, PR #197 | None for issue-#122 scope | roadmap-maintainers | 2026-04-01 | weekly |
| Embedded wallet / signer integration architecture | Base active | In Progress | 50 | #50, #122, #105 | `sdk/README.md` embedded-wallet section, `@web3auth/modal` in `sdk/package.json`, PR #15 | Agroasys-owned auth/session must become the primary identity boundary while wallet bootstrap remains post-login and action-scoped | roadmap-maintainers | 2026-04-01 | weekly |
| Oracle trigger + approval + retry controls | Base active | In Progress | 70 | #51, #56, #61, #124 | `oracle/src/core/trigger-manager.ts`, `oracle/src/worker/confirmation-worker.ts`, `oracle/src/api/routes.ts`, `docs/runbooks/oracle-redrive.md`, PR #14 | Complete SOP hardening still open for follow-on work | roadmap-maintainers | 2026-04-01 | weekly |
| Treasury payout queue + audit traceability | Base active | Blocked | 40 | #52, #67, #126, #127 | `treasury/src/database/schema.sql`, `treasury/src/database/queries.ts`, `treasury/src/core/payout.ts`, PR #22 | Processing/audit workflow requires missing operator UI/workflow integration and bank/fiat boundary finalization | roadmap-maintainers | 2026-04-01 | weekly |
| Reconciliation reports (on-chain ↔ fiat evidence) | Base active | Done | 100 | #53 | `reconciliation/src/report-cli.ts`, `reconciliation/src/core/reconciliationReport.ts`, `reconciliation/src/tests/reconciliation-report.test.ts`, `scripts/staging-e2e-real-gate.sh`, `.github/workflows/release-gate.yml` (`ci-report-reconciliation-report`), `docs/runbooks/reconciliation.md`, PR #182 | None for issue-#53 scope | roadmap-maintainers | 2026-04-01 | weekly |
| AssetHub assets + USDC fee conversion validation | Historical archive | Out of Scope | 0 | #63 | `scripts/asset-fee-path-gate.sh`, `scripts/asset-fee-path-validate.mjs`, `scripts/tests/asset-fee-path-gate.test.sh`, `docs/runbooks/asset-conversion-fee-validation.md`, `.github/workflows/historical-archive-maintenance.yml` (`historical-asset-fee-path`) | Historical AssetHub-only validation retained for audit; not active Base v1 truth | roadmap-maintainers | 2026-04-01 | archive-only |
| PolkaVM deployment verification + smoke checks | Historical archive | Out of Scope | 0 | #64 | `scripts/polkavm-deploy-verify.mjs`, `scripts/tests/polkavm-deploy-verify-smoke.test.mjs`, `docs/runbooks/polkavm-deploy-verification.md`, `.github/workflows/historical-archive-maintenance.yml` (`historical-polkavm-deploy-verification`) | Historical PolkaVM evidence retained for audit; not active Base v1 truth | roadmap-maintainers | 2026-04-01 | archive-only |
| Mainnet pilot execution evidence | Historical archive | Out of Scope | 0 | #66 | `docs/runbooks/base-mainnet-go-no-go.md`, `docs/runbooks/base-mainnet-cutover-and-rollback.md`, `docs/runbooks/polkadot-retirement-checklist.md` | Historical pilot evidence package was retired with M5 launch governance closure; no separate proof bundle is active v1 truth | roadmap-maintainers | 2026-04-01 | archive-only |
| Hybrid split walkthrough + treasury-to-fiat SOP | Base active | Done | 100 | #67 | `docs/runbooks/hybrid-split-walkthrough.md`, `docs/runbooks/treasury-to-fiat-sop.md`, `README.md` runbook links | None for issue-#67 scope | roadmap-maintainers | 2026-04-01 | weekly |
| Pilot documentation package (env + legal/KPI/demo templates + user guide) | Base active | Done | 100 | #57, #58, #59, #60, #68 | `docs/runbooks/pilot-environment-onboarding.md`, `docs/runbooks/staging-e2e-real-release-gate.md`, `docs/runbooks/pilot-kpi-report-template.md`, `docs/runbooks/demo/community-demo-checklist.md`, `docs/runbooks/demo/community-demo-script.md`, `docs/runbooks/non-custodial-pilot-user-guide.md`, `docs/runbooks/legal-evidence-package-template.md` | None for documentation scope deliverables in repo | roadmap-maintainers | 2026-04-01 | weekly |
| Pilot lessons-learned case study (post-live execution) | Post-pilot | Out of Scope | 0 | #69 | None in repo yet | Deferred until real pilot execution evidence exists | roadmap-maintainers | 2026-04-01 | weekly |
| Infrastructure controls (CI/CD, roadmap governance, release controls) | Base active | In Progress | 70 | #70, #71, #72, #73, #100, #104, #125, #131 | `.github/workflows/ci.yml`, `.github/workflows/pr-roadmap-policy.yml`, `docs/runbooks/github-roadmap-governance.md`, PR #62, PR #76 | Coverage matrix + gate linkage exists, but monitoring baseline, dependency major-upgrade backlog, and consistency enforcement are still open | roadmap-maintainers | 2026-04-01 | weekly |
| Primary DB operations + recovery evidence | Base active | Done | 100 | #133 | `scripts/postgres-backup-restore-smoke.sh`, `docs/runbooks/postgres-backup-restore-recovery.md`, `docs/runbooks/production-readiness-checklist.md`, `.github/workflows/release-gate.yml` (`ci-report-postgres-recovery-smoke`), PR #183 | None for issue-#133 scope | roadmap-maintainers | 2026-04-01 | weekly |
| Notifications service behavior + operational controls | Base active | Done | 100 | #77, #130 | `notifications/src/`, `notifications/tests/`, `scripts/notifications-wiring-health.sh`, `scripts/notifications-gate.sh`, `scripts/notifications-gate-validate.mjs`, `.github/workflows/release-gate.yml` (`ci-report-notifications-gate`) | None for issue-#130 scope | roadmap-maintainers | 2026-04-01 | weekly |
| API gateway orchestration + error handoff boundary | Base active | Backlog | 0 | #78, #123, #124 | Architectural requirement documented in the source-of-truth architecture diagram; no dedicated in-repo service boundary document | Define and implement runtime gateway and error-handler control plane | roadmap-maintainers | 2026-04-01 | weekly |
| Compliance boundary policy contract (KYB/KYT/Sanctions) | Base active | Done | 100 | #128 | `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`, `docs/runbooks/production-readiness-checklist.md` (Compliance boundary governance section), decision record #200 | None for issue-#128 policy documentation and governance-contract scope; provider runtime integration is tracked separately from this row | roadmap-maintainers | 2026-04-01 | weekly |
| Governance signing model — human privileged governance → direct admin wallet signing | Base active | Done | 100 | #411 | `docs/adr/adr-0411-human-governance-direct-wallet-signing.md`, `docs/runbooks/gateway-governance-signer-custody.md`, `docs/api/cotsel-dashboard-gateway.openapi.yml`, gateway direct-sign prepare/confirm/monitoring code and tests | Runtime model is implemented; remaining proof work is environment/browser validation outside this matrix row | roadmap-maintainers | 2026-04-09 | weekly |

## Base-Era Maintenance Rule

Before marking an active Base release gate or production-readiness checkpoint `Done`:
1. Ensure each related row above is either `Done`, explicitly `Blocked`, or explicitly `Out of Scope` with rationale recorded in the controlling issue or runbook.
2. Ensure each `Done` row references concrete repo evidence: files, tests, merged PRs, or CI runs.
3. Keep historical rows marked `archive-only`; they must never be reused as active Base readiness evidence.
