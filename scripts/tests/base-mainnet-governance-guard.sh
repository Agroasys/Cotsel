#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

GO_NO_GO_DOC="docs/runbooks/base-mainnet-go-no-go.md"
CUTOVER_DOC="docs/runbooks/base-mainnet-cutover-and-rollback.md"
fail=0

if [[ ! -f "$GO_NO_GO_DOC" ]]; then
  echo "[FAIL] Missing required runbook: ${GO_NO_GO_DOC}" >&2
  exit 1
fi

if [[ ! -f "$CUTOVER_DOC" ]]; then
  echo "[FAIL] Missing required runbook: ${CUTOVER_DOC}" >&2
  exit 1
fi

go_no_go_headings=(
  "## Purpose and scope"
  "## Authoritative references"
  "## Required approval roles"
  "## Required evidence before approval"
  "## Repo-grounded validation commands"
  "## No-go conditions"
  "## Approval record"
)

for heading in "${go_no_go_headings[@]}"; do
  if ! grep -Fq "$heading" "$GO_NO_GO_DOC"; then
    echo "[FAIL] Missing required heading in ${GO_NO_GO_DOC}: ${heading}" >&2
    fail=1
  fi
done

cutover_headings=(
  "## Purpose and scope"
  "## Launch-day ownership matrix"
  "## Preconditions before cutover begins"
  "## Cutover steps"
  "## Rollback triggers"
  "## Rollback steps"
  "## Containment posture when rollback is partial or blocked"
)

for heading in "${cutover_headings[@]}"; do
  if ! grep -Fq "$heading" "$CUTOVER_DOC"; then
    echo "[FAIL] Missing required heading in ${CUTOVER_DOC}: ${heading}" >&2
    fail=1
  fi
done

required_refs=(
  "scripts/validate-env.sh staging-e2e-real"
  "scripts/staging-e2e-real-gate.sh"
  "scripts/notifications-gate.sh staging-e2e-real"
  "npm run -w reconciliation reconcile:report"
)

for ref in "${required_refs[@]}"; do
  if ! grep -Fq "$ref" "$GO_NO_GO_DOC" && ! grep -Fq "$ref" "$CUTOVER_DOC"; then
    echo "[FAIL] Missing required launch-governance reference: ${ref}" >&2
    fail=1
  fi
done

if [[ "$fail" -eq 0 ]]; then
  echo "Base mainnet governance guard: pass"
  exit 0
fi

exit 1
