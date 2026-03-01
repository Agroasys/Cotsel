# GitHub Roadmap Governance

## Purpose
Maintain a single execution board for `Agroasys.Web3layer` where every roadmap item and PR is mapped to milestone scope and delivery status.

## Project v2 Definition
- Project name: `Agroasys.Web3layer Roadmap`
- Project URL: `https://github.com/orgs/Agroasys/projects/5`
- Project node ID: `PVT_kwDODMhsg84BPnYZ`
- Status values: `Backlog`, `In Progress`, `In Review`, `Blocked`, `Done`
- Milestone values: `Milestone A: PolkaVM Smart Contract Escrow & Ricardian Architecture`, `Milestone B: Non-Custodial Integration & Hybrid Split Settlement`, `Milestone C: Pilot with 1 Buyer + 1 Cooperative & Enforceability Memo`, `Needs Triage`
- Area values: `Contracts`, `Oracle`, `Indexer`, `SDK`, `Reconciliation`, `Ricardian`, `Treasury`, `Notifications`, `Ops/CI`, `Docs/Runbooks`, `Security`
- Work type values: `Feature`, `Bug`, `Refactor`, `Ops`, `Docs`, `Security` (`Type` is a reserved project field name in GitHub UI/API).

## Runtime Profile Context
- `local-dev`: fast local feedback with lightweight indexer responder.
- `staging-e2e-real`: release-gate profile using real indexer pipeline (`indexer-migrate`, `indexer-pipeline`, `indexer-graphql`).
- Release gate policy: `staging-e2e-real` health + gate checks must pass before release promotion.

## PR Policy (Required)
Every PR must:
1. Have a repo milestone assigned.
2. Be added to Project v2 (`Agroasys.Web3layer Roadmap`).
3. Keep CI green and avoid ABI/economics/token-flow changes unless explicitly approved.

The workflow `.github/workflows/pr-roadmap-policy.yml` enforces (1) and (2).
During temporary rollout without GitHub App auth, project-link enforcement is advisory (warnings only); milestone enforcement remains blocking.

## Weighted Progress (Authoritative)
- Authoritative milestone delivery status is the weighted rollup, not the native GitHub closed/open ratio.
- Source of truth for component mapping: `docs/runbooks/architecture-coverage-matrix.md`.
- Automation workflow: `.github/workflows/roadmap-weighted-progress-sync.yml`.
- Sync behavior:
  1. Recompute weighted `% Complete` for Milestones A/B/C from deliverable issues.
  2. Update milestone gate issues `#70/#71/#72` status label + `% Complete`.
  3. Update milestone descriptions with the weighted status.
  4. Update Project v2 gate item fields (`Status`, `% Complete`) when project access is available.

## Maintainer Steps For Each PR
1. Assign milestone:
```bash
gh pr edit <PR_NUMBER> --repo Agroasys/Agroasys.Web3layer --milestone "<Milestone Name>"
```
2. Add PR to Project v2:
```bash
pr_id="$(gh pr view <PR_NUMBER> --repo Agroasys/Agroasys.Web3layer --json id -q .id)"
gh api graphql \
  -f query='mutation($project:ID!,$content:ID!){ addProjectV2ItemById(input:{projectId:$project,contentId:$content}) { item { id } } }' \
  -F project="$ROADMAP_PROJECT_ID" \
  -F content="$pr_id"
```
3. Set project fields (`Status`, `Roadmap Milestone`, `Area`, `Priority`, `Work Type`, `Risk`, `% Complete`, `Target Date`).

## Required Repository Configuration
- Repository variable: `ROADMAP_PROJECT_ID` (Project v2 node id).
- Workflow permission: `.github/workflows/pr-roadmap-policy.yml` must keep `repository-projects: read`.
- Roadmap policy auth/runbook: `docs/runbooks/roadmap-policy.md`.

For weighted progress sync (optional overrides; defaults are built in for current project):
- `ROADMAP_PERCENT_FIELD_ID`
- `ROADMAP_STATUS_FIELD_ID`
- `ROADMAP_STATUS_OPTION_BACKLOG`
- `ROADMAP_STATUS_OPTION_IN_PROGRESS`
- `ROADMAP_STATUS_OPTION_DONE`

Auth for project field writes:
- Preferred: `ROADMAP_APP_ID` + `ROADMAP_APP_PRIVATE_KEY` (+ optional `ROADMAP_APP_INSTALLATION_ID`).
- Fallback: `github.token` (may be unable to write org ProjectV2 fields depending on org visibility/policy).

## Architecture-Matrix Consistency Guard
- Checker script: `scripts/architecture-roadmap-consistency-check.mjs`
- Sync helper: `scripts/arch-roadmap-sync.mjs`
- CI artifact: `ci-report-arch-roadmap-consistency`
- CI drift artifacts (on failure): `arch-roadmap-sync.json`, `arch-roadmap-sync.patch`

What the checker enforces:
1. Required matrix row metadata columns exist and are populated:
   - `Owner`
   - `Last Refreshed`
   - `Refresh Cadence`
2. Status/evidence consistency rules:
   - `Done` rows require `100%` and `Remaining Gap` starting with `None`.
   - Non-`Done`/non-`Out of Scope` rows cannot be `100%` or claim no remaining gap.
3. Gate synchronization:
   - Issues `#70/#71/#72` must contain `Last synchronized: <date>` matching matrix snapshot date.
   - Gate issue bodies must reference `docs/runbooks/architecture-coverage-matrix.md`.

Operator flow (deterministic + safe defaults):
1. Check drift locally:
```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/architecture-roadmap-consistency-check.mjs --repo Agroasys/Agroasys.Web3layer
```
2. Generate deterministic sync plan + patch:
```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo Agroasys/Agroasys.Web3layer
```
3. Apply minimum-safe matrix sync updates (default):
```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo Agroasys/Agroasys.Web3layer --write
```
4. Optional: normalize `% Complete` + `Remaining Gap` when you intentionally want policy normalization:
```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo Agroasys/Agroasys.Web3layer --write --normalize-progress
```
5. If gate issue metadata is out of sync, update gate issues (requires explicit apply flag):
```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo Agroasys/Agroasys.Web3layer --write-gate-issues --apply
```
6. Commit matrix changes and rerun CI checks:
```bash
git add docs/runbooks/architecture-coverage-matrix.md
git commit -m "docs(roadmap): sync architecture coverage matrix"
```

Manual/offline commands:
```bash
# offline schema/format checks
node scripts/architecture-roadmap-consistency-check.mjs --offline

# offline sync plan from cached issue snapshot
node scripts/arch-roadmap-sync.mjs --offline
```
