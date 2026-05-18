#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

fail=0

paths=(
  docs/runbooks
  docs/adr
  README.md
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
  exit 0
fi

exit 1
