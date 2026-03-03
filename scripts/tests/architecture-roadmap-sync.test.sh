#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/arch-roadmap-sync.mjs"
REPO_NAME='test-org/test-repo'
REPO_ISSUES_BASE_URL="https://github.com/$REPO_NAME/issues"
EXPECTED_NORMALIZED_REMAINING_GAP='None (auto-synced from closed issues)'
EXPECTED_DEFAULT_ROW='| Example component | A | Done | 40 | #101 | `docs/example.md` |'\
' Pending final closeout validation | roadmap-maintainers | 2026-03-01 | weekly |'
EXPECTED_NORMALIZED_ROW='| Example component | A | Done | 100 | #101 | `docs/example.md` | '"$EXPECTED_NORMALIZED_REMAINING_GAP"' |'\
' roadmap-maintainers | 2026-03-01 | weekly |'

tmp_dir="$(mktemp -d)"

cleanup_tmp_dir() {
  if [[ -n "${tmp_dir:-}" && -d "$tmp_dir" ]]; then
    case "$tmp_dir" in
      /tmp/*|/var/tmp/*|/var/folders/*|/private/var/folders/*)
        rm -rf "$tmp_dir"
        ;;
      *)
        printf '%s\n' "Skipping cleanup of unexpected tmp_dir path: $tmp_dir" >&2
        ;;
    esac
  fi
}
trap cleanup_tmp_dir EXIT

matrix="$tmp_dir/matrix.md"
cache="$tmp_dir/cache.json"
report="$tmp_dir/sync-report.json"
patch="$tmp_dir/sync.patch"
report_write_min="$tmp_dir/sync-report-write-min.json"
report_write_norm="$tmp_dir/sync-report-write-norm.json"
report_gate="$tmp_dir/write-gate-report.json"
patch_gate="$tmp_dir/write-gate.patch"
log="$tmp_dir/sync.log"

clear_log() {
  > "$log"
}

run_sync_script() {
  node "$SCRIPT" --offline --matrix "$matrix" --cache "$cache" "$@"
}

run_validator() {
  local mode="$1"
  local report_path="$2"

  if ! node "$ROOT_DIR/scripts/tests/architecture-roadmap-sync-validator.mjs" "$mode" "$report_path"; then
    echo "validator failed for mode '$mode' using report '$report_path'" >&2
    if [[ -f "$log" ]]; then
      echo "sync helper output was:" >&2
      cat "$log" >&2
    fi
    exit 1
  fi
}

write_matrix_fixture() {
  cat > "$matrix" <<'MATRIX'
# Architecture Coverage Matrix

Snapshot date: 2026-03-01

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Example component | A | In Progress | 40 | #101 | `docs/example.md` | Pending final closeout validation | roadmap-maintainers | 2026-02-25 | weekly |

## Gate-to-Row Mapping
MATRIX
}

write_matrix_fixture
cat > "$cache" <<CACHE
{
  "generatedAt": "2026-03-01T00:00:00.000Z",
  "repo": "$REPO_NAME",
  "issues": [
    {
      "number": 70,
      "state": "open",
      "body": "Last synchronized: 2026-03-01\nSource matrix: docs/runbooks/architecture-coverage-matrix.md",
      "url": "$REPO_ISSUES_BASE_URL/70"
    },
    {
      "number": 71,
      "state": "open",
      "body": "Last synchronized: 2026-03-01\nSource matrix: docs/runbooks/architecture-coverage-matrix.md",
      "url": "$REPO_ISSUES_BASE_URL/71"
    },
    {
      "number": 72,
      "state": "open",
      "body": "Last synchronized: 2026-03-01\nSource matrix: docs/runbooks/architecture-coverage-matrix.md",
      "url": "$REPO_ISSUES_BASE_URL/72"
    },
    {
      "number": 101,
      "state": "closed",
      "body": "Closed issue",
      "url": "$REPO_ISSUES_BASE_URL/101"
    }
  ]
}
CACHE

# Clear log file before check-mode scenario.
clear_log
if run_sync_script --out "$report" --patch "$patch" >>"$log" 2>&1; then
  echo "expected sync helper to fail in check mode when stale rows exist" >&2
  echo "sync helper output was:" >&2
  if [[ -f "$log" ]]; then
    cat "$log" >&2
  fi
  exit 1
fi

run_validator check "$report"

if ! grep -Fq "$EXPECTED_DEFAULT_ROW" "$patch"; then
  echo "expected default patch to update only Status and Last Refreshed" >&2
  exit 1
fi
if grep -Fq "$EXPECTED_NORMALIZED_ROW" "$patch"; then
  echo "did not expect normalized row (% Complete and Remaining Gap) in default mode patch" >&2
  exit 1
fi
if grep -Fq "$EXPECTED_NORMALIZED_REMAINING_GAP" "$patch"; then
  echo "did not expect Remaining Gap normalization in default mode patch" >&2
  exit 1
fi

write_matrix_fixture
# Clear log file before minimum-write scenario.
clear_log
if ! run_sync_script --write --out "$report_write_min" --patch "$patch" >>"$log" 2>&1; then
  echo "expected default write mode to apply minimum-safe row updates" >&2
  echo "sync helper output was:" >&2
  if [[ -f "$log" ]]; then
    cat "$log" >&2
  fi
  exit 1
fi

run_validator write-min "$report_write_min"

if ! grep -Fq "$EXPECTED_DEFAULT_ROW" "$matrix"; then
  echo "expected default write mode to keep % Complete and Remaining Gap unchanged" >&2
  exit 1
fi

write_matrix_fixture
# Clear log file before normalized-write scenario.
clear_log
if ! run_sync_script --write --normalize-progress --out "$report_write_norm" --patch "$patch" >>"$log" 2>&1; then
  echo "expected write + normalize-progress mode to apply extended sync updates" >&2
  echo "sync helper output was:" >&2
  if [[ -f "$log" ]]; then
    cat "$log" >&2
  fi
  exit 1
fi

run_validator write-norm "$report_write_norm"

if ! grep -Fq "$EXPECTED_NORMALIZED_ROW" "$matrix"; then
  echo "expected normalize-progress write mode to rewrite progress fields" >&2
  exit 1
fi

# Clear log file before write-gate-issues guard scenario.
clear_log
apply_guard_err="$tmp_dir/apply-guard.err"
if run_sync_script --write-gate-issues --out "$report_gate" --patch "$patch_gate" >>"$log" 2> "$apply_guard_err"; then
  echo "expected write-gate-issues without --apply to fail" >&2
  exit 1
fi
if ! grep -q -- "--write-gate-issues requires --apply" "$apply_guard_err"; then
  echo "expected actionable --apply guard error message" >&2
  exit 1
fi

echo "architecture-roadmap sync helper offline validation: pass"
