#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RUNBOOK="docs/runbooks/gateway-governance-signer-custody.md"
LINK_DOCS=(
  "docs/runbooks/dashboard-gateway-operations.md"
  "docs/runbooks/production-readiness-checklist.md"
  "docs/runbooks/emergency-disable-unpause.md"
)
required_headings=(
  "## Purpose and scope"
  "## Current code boundary"
  "## Approved custody models"
  "## Approval and execution procedure"
  "## Rotation and revocation"
  "## Break-glass and emergency disable"
  "## Evidence and audit minimums"
)

fail=0

if [[ ! -f "$RUNBOOK" ]]; then
  echo "[FAIL] Missing signer custody runbook: ${RUNBOOK}" >&2
  exit 1
fi

for heading in "${required_headings[@]}"; do
  if ! grep -Fq "$heading" "$RUNBOOK"; then
    echo "[FAIL] Missing required heading in ${RUNBOOK}: ${heading}" >&2
    fail=1
  fi
done

for doc in "${LINK_DOCS[@]}"; do
  if [[ ! -f "$doc" ]]; then
    echo "[FAIL] Missing linked doc: ${doc}" >&2
    fail=1
    continue
  fi

  if ! grep -Fq "docs/runbooks/gateway-governance-signer-custody.md" "$doc"; then
    echo "[FAIL] Missing signer custody runbook link in ${doc}" >&2
    fail=1
  fi
done

if [[ "$fail" -eq 0 ]]; then
  echo "Gateway signer custody guard: pass"
  exit 0
fi

exit 1
