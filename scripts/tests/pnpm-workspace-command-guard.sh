#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

fail=0

paths=(
  docs/runbooks
  docs/adr
  docs/security
  docs/licensing.md
  README.md
  CONTRIBUTING.md
  auth/README.md
  contracts/README.md
  indexer/README.md
  notifications/README.md
  oracle/README.md
  reconciliation/README.md
  ricardian/README.md
  sdk/README.md
  treasury/README.md
)

exclude_args=(
  --glob '!docs/runbooks/*closeout*.md'
)

if rg --line-number -P '\bnpm ci\b' "${exclude_args[@]}" "${paths[@]}"; then
  echo "Found deprecated npm ci command in active docs." >&2
  fail=1
fi

if rg --line-number -P '\bnpm run\b' "${exclude_args[@]}" "${paths[@]}"; then
  echo "Found deprecated npm run command in active docs." >&2
  fail=1
fi

if rg --line-number -P '\bnpm -w\b' "${exclude_args[@]}" "${paths[@]}"; then
  echo "Found deprecated npm workspace command in active docs." >&2
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "pnpm package-manager command guard: pass"
  node --test scripts/tests/documentation-integrity.test.mjs
  exit 0
fi

exit 1
