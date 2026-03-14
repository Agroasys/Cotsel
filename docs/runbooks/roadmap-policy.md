# Roadmap Policy Runbook

## What this policy enforces
The workflow `.github/workflows/pr-roadmap-policy.yml` enforces both requirements on every `pull_request` event:
- PR has a GitHub Milestone.
- PR is added to ProjectV2 `Cotsel Roadmap`.

Validation order is strict:
1. Direct PR -> `projectItems` match by `ROADMAP_PROJECT_ID`.
2. ProjectV2 contents scan with GraphQL pagination (`items(first:100, after:cursor)`) until found/exhausted.
3. Final fallback to `gh pr view --json projectItems` title match.

If all checks fail, the workflow fails.

Related automation:
- `.github/workflows/roadmap-weighted-progress-sync.yml` keeps weighted milestone progress in sync with roadmap deliverable issues and updates gate issue/project fields.

## Temporary rollout mode (current)
- Milestone check is always enforced (blocking).
- Project-link check runs in advisory mode when GitHub App auth is not configured.
- Advisory mode reports warnings but does not block PR merge.
- Strict mode is automatically enabled once GitHub App credentials are configured.

Optional override:
- Set repository variable `ROADMAP_POLICY_STRICT=true` to force strict blocking mode immediately.

## Security model
- Event: `pull_request` only.
- `pull_request_target` is forbidden because it runs with elevated repo permissions against untrusted fork code.
- No `actions/checkout` and no user-controlled scripts are executed.
- Minimal explicit permissions are used.
- Token values are masked and never echoed.

## Authentication model
Authentication priority is:
1. GitHub App installation token (`actions/create-github-app-token`) using repo secrets.
2. `github.token` fallback.

`ROADMAP_PROJECT_TOKEN` is intentionally not used.

## Required setup (GitHub App)
Create and install a GitHub App (org-owned preferred) with least privilege:
- Organization Projects: read
- Minimal repository read access required for API lookups

Set repository secrets:
- `ROADMAP_APP_ID`
- `ROADMAP_APP_PRIVATE_KEY`
- Optional: `ROADMAP_APP_INSTALLATION_ID`

The workflow automatically prefers the App token when these secrets are present.

## Required repository variable
Set:
- `ROADMAP_PROJECT_ID` = ProjectV2 node ID for `Cotsel Roadmap`

Optional:
- `ROADMAP_PROJECT_TITLE` (defaults to `Cotsel Roadmap`)

## Troubleshooting
If the check fails:
1. Confirm PR has a milestone.
2. Confirm PR is added to the roadmap project.
3. Verify `ROADMAP_PROJECT_ID` is correct.
4. Confirm App secrets are present and App is installed for this repo/org.
5. If running on `github.token` fallback, org ProjectV2 visibility may be restricted (advisory mode until App auth is configured).
6. Re-run failed jobs after metadata/auth fixes.

## Manual cleanup
Maintainer action required:
1. Ensure GitHub App secrets are configured and policy check passes.
2. Delete legacy `ROADMAP_PROJECT_TOKEN` in GitHub UI (unsupported by policy workflow).
3. Rotate any previously used broad personal token outside this repo.
