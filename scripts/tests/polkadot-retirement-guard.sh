#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RELEASE_GATE=".github/workflows/release-gate.yml"
HISTORICAL_WORKFLOW=".github/workflows/historical-archive-maintenance.yml"
RETIREMENT_DOC="docs/runbooks/polkadot-retirement-checklist.md"
OPENAPI_DOC="docs/api/cotsel-dashboard-gateway.openapi.yml"
fail=0

if [[ ! -f "$HISTORICAL_WORKFLOW" ]]; then
  echo "[FAIL] Missing historical archive workflow: ${HISTORICAL_WORKFLOW}" >&2
  fail=1
fi

if [[ ! -f "$RETIREMENT_DOC" ]]; then
  echo "[FAIL] Missing retirement checklist: ${RETIREMENT_DOC}" >&2
  fail=1
fi

if grep -Eq 'ci/arch-roadmap-consistency-historical|ci/asset-fee-path-historical|ci/contracts-deploy-verification-historical' "$RELEASE_GATE"; then
  echo "[FAIL] Active release gate still references historical Polkadot jobs" >&2
  fail=1
fi

if grep -Eq 'architecture-roadmap-consistency-check\.test\.sh|architecture-roadmap-sync\.test\.sh' "$RELEASE_GATE"; then
  echo "[FAIL] Active release gate still runs historical A/B/C regression tests" >&2
  fail=1
fi

if grep -Fq 'extrinsicHash:' "$OPENAPI_DOC"; then
  echo "[FAIL] Active OpenAPI surface still exposes extrinsicHash" >&2
  fail=1
fi

required_headings=(
  "## Purpose and scope"
  "## Binding register"
  "## Retirement decisions"
  "## M5-owned residue closure table"
  "## Active-surface retirement checks"
  "## Validation procedure"
  "## Closure rule"
)

for heading in "${required_headings[@]}"; do
  if ! grep -Fq "$heading" "$RETIREMENT_DOC"; then
    echo "[FAIL] Missing required heading in ${RETIREMENT_DOC}: ${heading}" >&2
    fail=1
  fi
done

if ! grep -Fq '#356' "$RETIREMENT_DOC"; then
  echo "[FAIL] Retirement checklist must bind directly to issue #356" >&2
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "Polkadot retirement guard: pass"
  exit 0
fi

exit 1
