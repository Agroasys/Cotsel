#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DOC_PATH="docs/runbooks/programmability-governance.md"
fail=0

if [[ ! -f "$DOC_PATH" ]]; then
  echo "[FAIL] Missing required runbook: ${DOC_PATH}" >&2
  exit 1
fi

required_headings=(
  "## Purpose and scope"
  "## Non-goals"
  "## Allowed automation classes"
  "## Approval authority and change control"
  "## Kill-switch and rollback strategy"
  "## Evidence and audit minimums"
  "## Service-specific operational references"
  "## Review cadence"
)

for heading in "${required_headings[@]}"; do
  if ! grep -Fq "$heading" "$DOC_PATH"; then
    echo "[FAIL] Missing required heading in ${DOC_PATH}: ${heading}" >&2
    fail=1
  fi
done

if [[ "$fail" -eq 0 ]]; then
  echo "Programmability governance guard: pass"
  exit 0
fi

exit 1
