#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/arch-roadmap-sync.mjs"
REPO_NAME='test-org/test-repo'
REPO_ISSUES_BASE_URL="https://github.com/$REPO_NAME/issues"
EXPECTED_NORMALIZED_REMAINING_GAP='None (auto-synchronized from closed issues)'
# Fixture starts "In Progress"; expected rows are "Done" to confirm status sync.
OFFLINE_MODE_REQUIRED_ERROR_KEY='ERR_OFFLINE_MODE_REQUIRED'
WRITE_GATE_ISSUES_APPLY_GUARD_PREFIX='ERROR: --write-gate-issues requires --apply. Re-run with:'
WRITE_GATE_ISSUES_APPLY_GUARD_COMMAND='GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo "'"${REPO_NAME}"'" --write-gate-issues --apply'
EXPECTED_WRITE_GATE_ISSUES_APPLY_GUARD_MESSAGE="${WRITE_GATE_ISSUES_APPLY_GUARD_PREFIX} ${WRITE_GATE_ISSUES_APPLY_GUARD_COMMAND}"
# Optional: set RUN_GATE_ISSUES_E2E=true to enable online end-to-end validation of
#           --write-gate-issues --apply against GitHub; leave unset for offline-only checks.

# Shared row fields to keep fixture and expectations in sync.
ROW_COMPONENT='Example component'
ROW_MILESTONE='A'
ROW_ISSUE='#101'
ROW_EVIDENCE='`docs/example.md`'
ROW_OWNER='roadmap-maintainers'
ROW_REFRESH_CADENCE='weekly'
ROW_REMAINING_GAP_INITIAL='Pending final closeout validation'
ROW_LAST_REFRESHED_INITIAL='2026-02-23'
ROW_LAST_REFRESHED_EXPECTED='2026-03-01'
# Expected rows after sync (default and normalized modes).
EXPECTED_DEFAULT_ROW="| ${ROW_COMPONENT} | ${ROW_MILESTONE} | Done | 40 | ${ROW_ISSUE} | ${ROW_EVIDENCE} | ${ROW_REMAINING_GAP_INITIAL} | ${ROW_OWNER} | ${ROW_LAST_REFRESHED_EXPECTED} | ${ROW_REFRESH_CADENCE} |"
EXPECTED_NORMALIZED_ROW="| ${ROW_COMPONENT} | ${ROW_MILESTONE} | Done | 100 | ${ROW_ISSUE} | ${ROW_EVIDENCE} | ${EXPECTED_NORMALIZED_REMAINING_GAP} | ${ROW_OWNER} | ${ROW_LAST_REFRESHED_EXPECTED} | ${ROW_REFRESH_CADENCE} |"
# Initial matrix row used in the fixture before sync.
MATRIX_INITIAL_ROW="| ${ROW_COMPONENT} | ${ROW_MILESTONE} | In Progress | 40 | ${ROW_ISSUE} | ${ROW_EVIDENCE} | ${ROW_REMAINING_GAP_INITIAL} | ${ROW_OWNER} | ${ROW_LAST_REFRESHED_INITIAL} | ${ROW_REFRESH_CADENCE} |"

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
validator_log="$tmp_dir/validator.log"

clear_log() {
  # Truncate the log file before each scenario, but only if the path is valid.
  if [[ -n "${log:-}" ]]; then
    local log_dir
    log_dir="$(dirname -- "$log")" || {
      printf '%s\n' "Skipping log truncation: unable to determine directory for log path: ${log:-<unset>}" >&2
      return
    }
    if [[ -d "$log_dir" ]]; then
      > "$log"
    else
      printf '%s\n' "Skipping log truncation: parent directory does not exist for log path: $log" >&2
    fi
  else
    printf '%s\n' "Skipping log truncation: log path is unset or empty" >&2
  fi
}

run_sync_script() {
  node "$SCRIPT" --offline --repo "$REPO_NAME" --matrix "$matrix" --cache "$cache" "$@"
}

run_sync_script_online() {
  node "$SCRIPT" --repo "$REPO_NAME" --matrix "$matrix" --cache "$cache" "$@"
}

run_validator() {
  local mode="$1"
  local report_path="$2"

  if ! node "$ROOT_DIR/scripts/tests/architecture-roadmap-sync-validator.mjs" "$mode" "$report_path" 2>"$validator_log"; then
    echo "validator failed for mode '$mode' using report '$report_path'" >&2
    if [ -s "$validator_log" ]; then
      echo "validator stderr output was:" >&2
      cat "$validator_log" >&2
    else
      echo "validator produced no stderr output." >&2
    fi
    echo "sync helper log output was:" >&2
    cat "$log" >&2
    exit 1
  fi
}

show_log_on_error() {
  echo "sync helper log output was:" >&2
  cat "$log" >&2
}

write_matrix_fixture() {
  cat > "$matrix" <<MATRIX
# Architecture Coverage Matrix

Snapshot date: 2026-03-01

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
$MATRIX_INITIAL_ROW

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
# In check mode, the sync helper should exit non-zero when stale rows are detected.
if run_sync_script --out "$report" --patch "$patch" >>"$log" 2>&1; then
  echo "expected sync helper to fail in check mode when stale rows exist" >&2
  show_log_on_error
  exit 1
fi

run_validator check "$report"

if ! grep -Fq "$EXPECTED_DEFAULT_ROW" "$patch"; then
  echo "expected default patch to update only Status and Last Refreshed" >&2
  echo "Expected row:" >&2
  printf '%s\n' "$EXPECTED_DEFAULT_ROW" >&2
  echo "Actual patch contents:" >&2
  cat "$patch" >&2
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
  show_log_on_error
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
  show_log_on_error
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
if ! grep -Fq -- "$EXPECTED_WRITE_GATE_ISSUES_APPLY_GUARD_MESSAGE" "$apply_guard_err"; then
  echo "expected actionable --apply guard error message" >&2
  exit 1
fi

# Now validate successful write-gate-issues behavior when --apply is provided.
clear_log
report_gate_apply="$tmp_dir/report-gate-apply.json"
# RUN_GATE_ISSUES_E2E=true enables an online end-to-end check that --write-gate-issues --apply
# can successfully synchronize gate issues against GitHub. Leave it unset for the default
# offline-only mode, which verifies that an online-only operation is correctly guarded.
if [[ "${RUN_GATE_ISSUES_E2E:-}" == "true" ]]; then
  # Note: run_sync_script_online intentionally does not pass --offline and may reuse the same
  # cache file as offline runs; this branch is meant to exercise real GitHub API calls and
  # end-to-end synchronization behavior, even when a shared cache is present.
  if ! run_sync_script_online --write-gate-issues --apply --out "$report_gate_apply" --patch "$patch_gate" >>"$log" 2>&1; then
    echo "expected write-gate-issues with --apply to succeed and synchronize gate issues" >&2
    show_log_on_error
    exit 1
  fi
  if [[ ! -s "$report_gate_apply" ]]; then
    echo "expected write-gate-issues --apply run to produce a non-empty gate report at $report_gate_apply" >&2
    exit 1
  fi
else
  if run_sync_script --write-gate-issues --apply --out "$report_gate_apply" --patch "$patch_gate" >>"$log" 2>&1; then
    echo "expected write-gate-issues with --apply to fail in offline mode" >&2
    exit 1
  fi
  if ! grep -Fq -- "$OFFLINE_MODE_REQUIRED_ERROR_KEY" "$log"; then
    echo "expected offline guard message for write-gate-issues --apply" >&2
    show_log_on_error
    exit 1
  fi
fi

echo "architecture-roadmap sync helper offline validation: pass"
