# Architecture Coverage Matrix

Snapshot date: 2026-02-22

Scope:
- Source of truth is repository code, merged/open PRs, and roadmap issues.
- KYC/KYB/AML vendor systems are intentionally excluded from this matrix.

Status legend:
- `Done`: acceptance criteria implemented and evidenced in repo/CI.
- `In Progress`: partial implementation with measurable gaps.
- `Blocked`: depends on missing in-repo surface or external dependency.
- `Backlog`: not started.

Production readiness checklist:
- `docs/runbooks/production-readiness-checklist.md`

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap |
| --- | --- | --- | --- | --- | --- | --- |
| Escrow lifecycle + split-settlement safety | A | Done | 100 | #42, #54 | `contracts/tests/AgroasysEscrow.ts`, `contracts/foundry/test/AgroasysEscrowFuzz.t.sol`, PR #8, PR #13, CI run 22197616358 (`ci/contracts` success) | None for milestone-A baseline |
| Ricardian PDF/hash service | A | In Progress | 75 | #43 | `ricardian/src/utils/hash.ts`, `ricardian/src/utils/canonicalize.ts`, `ricardian/tests/canonicalize.test.ts`, `sdk/src/modules/ricardianClient.ts`, PR #21 | Production storage/retrieval failure-handling documentation still incomplete |
| Indexer pipeline + GraphQL schema correctness | A/B | In Progress | 50 | #44 | `indexer/src/main.ts`, `indexer/schema.graphql`, `indexer/db/migrations/1771180205323-Data.js`, PR #23 | `extrinsic_hash` is not a first-class field; tx/extrinsic semantics still conflated in storage/API |
| Reconciliation drift remediation | A/B | In Progress | 60 | #45 | `reconciliation/src/core/classifier.ts`, `reconciliation/src/core/reconciler.ts`, `reconciliation/src/tests/classifier-address-validation.test.ts`, `scripts/staging-e2e-gate.sh` | Deterministic retry/redrive state machine documentation + tests still incomplete |
| SDK typed modules + ABI parity | A | Done | 100 | #46, #50 | `sdk/src/modules/`, `sdk/tests/abiAlignment.test.ts`, `sdk/README.md`, PR #12, PR #15, CI run 22197616358 (`ci/sdk` success) | Unified checkout frontend integration remains blocked in #50 |
| Release gates + profile health determinism | A/B | In Progress | 75 | #47, #55 | `scripts/docker-services.sh`, `scripts/staging-e2e-gate.sh`, `scripts/tests/docker-services-args.test.sh`, PR #28, PR #39, PR #41 (open) | Staging-real gate promotion and full CI enforcement are not complete |
| Core docs + runbooks + developer guidance | A | In Progress | 80 | #49, #65 | `README.md`, `docs/docker-services.md`, `docs/runbooks/staging-e2e-release-gate.md`, `docs/runbooks/production-readiness-checklist.md`, PR #31, PR #34 | Keep checklist and runbook links updated as release controls evolve |
| Dashboard + unified checkout + settlement tracker | B | Blocked | 25 | #50 | SDK support exists (`sdk/src/modules/`, `sdk/README.md`), Web3Auth dependency present | No in-repo dashboard surface; end-to-end checkout UX not implemented here |
| Web3Auth signing/session architecture | B | In Progress | 50 | #50 | `sdk/README.md` Web3Auth section, `@web3auth/modal` in `sdk/package.json`, PR #15 | Full frontend/session lifecycle and operational runbook still missing |
| Oracle trigger + approval + retry controls | B/C | In Progress | 70 | #51, #56, #61 | `oracle/src/core/trigger-manager.ts`, `oracle/src/worker/confirmation-worker.ts`, `oracle/src/api/routes.ts`, `docs/runbooks/oracle-redrive.md`, PR #14 | Pilot manual-approval mode and complete SOP hardening still open |
| Treasury payout queue + audit traceability | B/C | Blocked | 40 | #52, #67 | `treasury/src/database/schema.sql`, `treasury/src/database/queries.ts`, `treasury/src/core/payout.ts`, PR #22 | Processing/audit workflow requires missing operator UI/workflow integration |
| Reconciliation reports (on-chain ↔ fiat evidence) | B | Backlog | 10 | #53 | Reconciliation run/drift persistence exists in `reconciliation/src/database/queries.ts` | No deterministic report generator + review cadence artifacts |
| AssetHub assets + USDC fee conversion validation | A | Backlog | 0 | #63 | Conceptual references in `README.md` only | No automated validation flow across local-dev/staging for fee-in-USDC path |
| PolkaVM deployment verification + smoke checks | A | Backlog | 0 | #64 | CI exists but no deployment-verification artifact workflow | No deterministic deploy verification bundle and smoke automation |
| Mainnet pilot execution evidence | B | Backlog | 0 | #66 | None in repo yet | No transaction evidence package or pilot proof artifacts |
| Hybrid split walkthrough + treasury-to-fiat SOP | B | Done | 100 | #67 | `docs/runbooks/hybrid-split-walkthrough.md`, `docs/runbooks/treasury-to-fiat-sop.md`, `README.md` runbook links | None for issue-#67 scope |
| Pilot environment + legal evidence + KPI/demo/case study package | C | In Progress | 55 | #57, #58, #59, #60, #68, #69 | `docs/runbooks/pilot-environment-onboarding.md`, `docs/runbooks/staging-e2e-real-release-gate.md`, `docs/runbooks/pilot-kpi-report-template.md`, `docs/runbooks/demo/community-demo-checklist.md`, `docs/runbooks/demo/community-demo-script.md`, `docs/runbooks/non-custodial-pilot-user-guide.md`, `docs/runbooks/legal-evidence-package-template.md` | Remaining pending artifacts are #69 (lessons-learned case study) |
| Infrastructure controls (CI/CD, roadmap governance, release controls) | A/B/C | In Progress | 70 | #70, #71, #72, #73 | `.github/workflows/ci.yml`, `.github/workflows/pr-roadmap-policy.yml`, `docs/runbooks/github-roadmap-governance.md`, PR #62, PR #76 | Coverage matrix + gate linkage is now established but milestones not yet fully satisfied |
| Notifications service behavior + operational controls | A/B | In Progress | 50 | #77 | `notifications/src/`, `notifications/tests/`, PR #20 | Needs dedicated roadmap completion criteria and runbook hardening |
| API gateway orchestration + error handoff boundary | A/B | Backlog | 0 | #78 | Architectural requirement documented in `web3layer.mmd`; no dedicated in-repo service boundary document | Define boundary contract, ownership, and failure handoff rules |

## Milestone Rollup (evidence-based)

- Milestone A: 56% (issue rollup from A deliverables excluding gate)
- Milestone B: 41% (issue rollup from B deliverables excluding gate)
- Milestone C: 0% (issue rollup from C deliverables excluding gate)

Computation method:
- Use roadmap issue `% Complete` values as authoritative per-deliverable status.
- Recompute after each issue status change or closure.
- Milestone gate issues (#70/#71/#72) track the rollup value and never lead it.

## Gate-to-Row Mapping

- Gate `#70` (Milestone A) maps to:
  Escrow lifecycle + split-settlement safety; Ricardian PDF/hash service; Indexer pipeline + GraphQL schema correctness; Reconciliation drift remediation; SDK typed modules + ABI parity; Release gates + profile health determinism; Core docs + runbooks + developer guidance; AssetHub assets + USDC fee conversion validation; PolkaVM deployment verification + smoke checks.
- Gate `#71` (Milestone B) maps to:
  Dashboard + unified checkout + settlement tracker; Web3Auth signing/session architecture; Oracle trigger + approval + retry controls; Treasury payout queue + audit traceability; Reconciliation reports; Mainnet pilot execution evidence; Hybrid split walkthrough + treasury-to-fiat SOP.
- Gate `#72` (Milestone C) maps to:
  Pilot environment + legal evidence + KPI/demo/case study package; Oracle trigger + approval + retry controls (pilot-safe mode); Treasury payout queue + audit traceability (pilot operations); Infrastructure controls (CI/CD, roadmap governance, release controls).

## Maintenance Rule

Before marking any milestone gate `Done`:
1. Ensure each related row above is either `Done` or explicitly out-of-scope with approval.
2. Ensure each `Done` row references concrete repo evidence (files, tests, merged PRs, CI run).
3. Update gate issue body `% Complete` and project field `% Complete` in the same change.
