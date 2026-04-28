#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DOC_PATH="docs/runbooks/production-sensitive-action-evidence.md"
fail=0

if [[ ! -f "$DOC_PATH" ]]; then
  echo "[FAIL] Missing production-sensitive action evidence index: ${DOC_PATH}" >&2
  exit 1
fi

required_terms=(
  "Base mainnet launch/cutover"
  "Human privileged governance signing"
  "Oracle manual approval/redrive"
  "Treasury sweep approval/execution"
  "External treasury handoff"
  "Reconciliation drift remediation"
  "Compliance override"
  "Secret rotation"
  "## Minimal Evidence Record"
  "Before state"
  "After state"
  "Evidence storage location"
  "docs/runbooks/operator-audit-evidence-template.md"
  "docs/incidents/incident-evidence-template.md"
)

for term in "${required_terms[@]}"; do
  if ! grep -Fq "$term" "$DOC_PATH"; then
    echo "[FAIL] Missing required evidence mapping in ${DOC_PATH}: ${term}" >&2
    fail=1
  fi
done

for linked_doc in \
  docs/runbooks/production-readiness-checklist.md \
  docs/runbooks/base-mainnet-go-no-go.md; do
  if ! grep -Fq "$DOC_PATH" "$linked_doc"; then
    echo "[FAIL] Missing ${DOC_PATH} link in ${linked_doc}" >&2
    fail=1
  fi
done

if [[ "$fail" -eq 0 ]]; then
  echo "Production-sensitive action evidence guard: pass"
  exit 0
fi

exit 1
