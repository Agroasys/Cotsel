#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RUNBOOK="docs/runbooks/oracle-redrive.md"
fail=0

if [[ ! -f "$RUNBOOK" ]]; then
  echo "[FAIL] Missing oracle redrive runbook: ${RUNBOOK}" >&2
  exit 1
fi

required_headings=(
  "## Runtime Retry Ceilings And Stop Conditions"
  "## Redrive Acceptance Checklist"
  "## Alert Thresholds"
  "## Decision Flow"
  "## Evidence To Collect For Incidents"
  "## Escalation Matrix"
  "## Manual Approval Mode (Pilot)"
)

required_terms=(
  "EXHAUSTED_NEEDS_REDRIVE"
  "TERMINAL_FAILURE"
  "actionKey"
  "attempt_count"
  "Only one controlled redrive is allowed per incident decision"
  "docs/runbooks/operator-audit-evidence-template.md"
)

for heading in "${required_headings[@]}"; do
  if ! grep -Fq "$heading" "$RUNBOOK"; then
    echo "[FAIL] Missing required heading in ${RUNBOOK}: ${heading}" >&2
    fail=1
  fi
done

for term in "${required_terms[@]}"; do
  if ! grep -Fq "$term" "$RUNBOOK"; then
    echo "[FAIL] Missing required oracle redrive control text in ${RUNBOOK}: ${term}" >&2
    fail=1
  fi
done

if [[ "$fail" -eq 0 ]]; then
  echo "Oracle redrive runbook guard: pass"
  exit 0
fi

exit 1
