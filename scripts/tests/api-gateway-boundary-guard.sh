#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DOC_PATH="docs/runbooks/api-gateway-boundary.md"
fail=0

if [[ ! -f "$DOC_PATH" ]]; then
  echo "[FAIL] Missing required runbook: ${DOC_PATH}" >&2
  exit 1
fi

required_headings=(
  "## Purpose and scope"
  "## Routing ownership and service contract"
  "## Authentication propagation rules (headers/claims, what must never be forwarded)"
  "## Correlation IDs + request IDs (exact fields, generation, logging expectations)"
  "## Timeouts and retries (default ceilings; per-service overrides; retry budget)"
  "## Failure modes: fallback, dead-letter, and \"who owns the incident\""
  "## Error taxonomy (client vs upstream vs infra) and expected response mapping"
  "## Observability requirements (log fields, metrics, traces)"
  "## Operational ownership matrix (RACI: gateway owner vs service owner vs on-call)"
  "## Runbook quick actions (first 15 minutes checklist links)"
)

for heading in "${required_headings[@]}"; do
  if ! grep -Fqx "$heading" "$DOC_PATH"; then
    echo "[FAIL] Missing required heading in ${DOC_PATH}: ${heading}" >&2
    fail=1
  fi
done

if [[ "$fail" -eq 0 ]]; then
  echo "api gateway boundary guard: pass"
  exit 0
fi

exit 1
