#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/cotsel.sh"

assert_fails() {
  if "$@" >/dev/null 2>&1; then
    echo "expected failure but command succeeded: $*" >&2
    exit 1
  fi
}

# These all fail during argument parsing, before any docker invocation.
assert_fails "$SCRIPT"                       # missing action
assert_fails "$SCRIPT" unknown-action        # unknown action
assert_fails "$SCRIPT" up --bogus            # unknown option
assert_fails "$SCRIPT" down --gate           # --gate only valid with up
assert_fails "$SCRIPT" up --skip-build       # --skip-build only valid with up --gate
assert_fails "$SCRIPT" health some-service   # service arg not allowed for health

echo "cotsel arg parser smoke: pass"
