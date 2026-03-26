#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RUNBOOK="docs/runbooks/chain-event-parity-retirement.md"
LINK_DOC="docs/runbooks/reconciliation.md"
required_headings=(
  "## Purpose and scope"
  "## Legacy ingest summary"
  "## Authoritative replacement matrix"
  "## Responsibilities intentionally retired"
  "## Retirement checklist"
  "## Operator verification procedure"
)
required_refs=(
  "indexer/src/main.ts"
  "reconciliation/src/indexer/client.ts"
  "gateway/src/core/tradeReadService.ts"
  "treasury/src/core/ingestion.ts"
)

fail=0

if [[ ! -f "$RUNBOOK" ]]; then
  echo "[FAIL] Missing chain-event parity runbook: ${RUNBOOK}" >&2
  exit 1
fi

for heading in "${required_headings[@]}"; do
  if ! grep -Fq "$heading" "$RUNBOOK"; then
    echo "[FAIL] Missing required heading in ${RUNBOOK}: ${heading}" >&2
    fail=1
  fi
done

for ref in "${required_refs[@]}"; do
  if ! grep -Fq "$ref" "$RUNBOOK"; then
    echo "[FAIL] Missing required replacement reference in ${RUNBOOK}: ${ref}" >&2
    fail=1
  fi
done

if [[ ! -f "$LINK_DOC" ]]; then
  echo "[FAIL] Missing reconciliation runbook: ${LINK_DOC}" >&2
  fail=1
elif ! grep -Fq "docs/runbooks/chain-event-parity-retirement.md" "$LINK_DOC"; then
  echo "[FAIL] Missing chain-event parity link in ${LINK_DOC}" >&2
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "Chain-event parity retirement guard: pass"
  exit 0
fi

exit 1
