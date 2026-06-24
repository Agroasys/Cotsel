#!/usr/bin/env bash
set -euo pipefail

# Guard against reintroducing the retired multi-profile / multi-env model in docs.
# There is one compose profile (`runtime`), one env file (`.env.runtime`), and
# one lifecycle script (`scripts/cotsel.sh`). The STAGING_E2E_REAL_* env-var
# names are intentionally retained as gate tuning knobs, so this guard only
# matches the lowercase profile/script forms.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

fail=0

# Repo-wide scan: docs plus every README.md (root and per-package), so package
# READMEs cannot drift back to retired artifacts either.
ALL_TARGETS=(docs)
while IFS= read -r readme; do
  ALL_TARGETS+=("$readme")
done < <(find . -type d -name node_modules -prune -o -type f -name 'README.md' -print | sed 's|^\./||')

# Narrow scan: docs + root README only. Per-package READMEs legitimately
# reference their own per-service `.env.example` (only the root layered env
# examples were deleted), so the removed-env-file vocabulary stays scoped here.
DOCS_TARGETS=(docs README.md)

# check <label> <pattern> <target>...
check() {
  local label="$1"
  local pattern="$2"
  shift 2
  if grep -RInE --include='*.md' -- "$pattern" "$@"; then
    echo "Found deprecated reference (${label}); use the runtime/cotsel equivalents." >&2
    fail=1
  fi
}

# Genuinely removed artifacts — referencing them anywhere is a regression.
check "docker-services.sh script"      'docker-services\.sh'                     "${ALL_TARGETS[@]}"
check "deploy.sh script"               'scripts/deploy\.sh'                      "${ALL_TARGETS[@]}"
check "staging-e2e gate scripts"       'staging-e2e(-real)?-gate\.sh'           "${ALL_TARGETS[@]}"
check "renamed/deleted docs"           'docs/docker-services\.md|docker-profiles\.md|staging-e2e-real-release-gate\.md' "${ALL_TARGETS[@]}"
check "lowercase staging-e2e profile"  'staging-e2e-real|staging-e2e'           "${ALL_TARGETS[@]}"
check "local-dev profile"              'local-dev'                              "${ALL_TARGETS[@]}"
check "deprecated compose profiles"    '--profile (local-dev|local|infra|staging-e2e-real|staging-e2e)' "${ALL_TARGETS[@]}"
check "removed dashboard parity"       'dashboard:parity|dashboard-(live|local)-parity' "${ALL_TARGETS[@]}"

# Removed root env files — scoped to docs + root README (per-service
# `.env.example` files still exist and are referenced by package READMEs).
check "removed env files"              '\.env\.(local|staging-e2e-real|staging-e2e|example)\b' "${DOCS_TARGETS[@]}"

if [[ "$fail" -eq 0 ]]; then
  echo "docs profile-name guard: pass"
  exit 0
fi

exit 1
