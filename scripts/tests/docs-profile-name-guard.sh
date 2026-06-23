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

check() {
  local label="$1"
  local pattern="$2"
  if grep -RInE --include='*.md' -- "$pattern" docs README.md; then
    echo "Found deprecated reference (${label}); use the runtime/cotsel equivalents." >&2
    fail=1
  fi
}

check "docker-services.sh script"      'docker-services\.sh'
check "deploy.sh script"               'scripts/deploy\.sh'
check "staging-e2e gate scripts"       'staging-e2e(-real)?-gate\.sh'
check "lowercase staging-e2e profile"  'staging-e2e-real|staging-e2e'
check "local-dev profile"              'local-dev'
check "deprecated compose profiles"    '--profile (local-dev|local|infra|staging-e2e-real|staging-e2e)'
check "removed dashboard parity"       'dashboard:parity|dashboard-(live|local)-parity'
check "removed env files"              '\.env\.(local|staging-e2e-real|staging-e2e|example)\b'

if [[ "$fail" -eq 0 ]]; then
  echo "docs profile-name guard: pass"
  exit 0
fi

exit 1
