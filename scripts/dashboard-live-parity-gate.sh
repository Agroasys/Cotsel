#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${DASHBOARD_PARITY_REPORT_DIR:-$ROOT_DIR/reports/dashboard-parity}"
LOG_DIR="${DASHBOARD_PARITY_LOG_DIR:-$REPORT_DIR/logs}"
REPORT_FILE="${DASHBOARD_PARITY_REPORT_FILE:-$REPORT_DIR/live-parity-gate.json}"
SESSION_FILE="${DASHBOARD_PARITY_CI_SESSION_FILE:-/tmp/cotsel-dashboard-session.json}"
DASHBOARD_REPO_DIR="${DASHBOARD_LIVE_SUITE_REPO_DIR:-$ROOT_DIR/../Cotsel-Dash}"
AUTH_BASE_URL="${DASHBOARD_PARITY_AUTH_BASE_URL:-http://127.0.0.1:3005/api/auth/v1}"
GATEWAY_BASE_URL="${DASHBOARD_PARITY_GATEWAY_BASE_URL:-http://127.0.0.1:3600/api/dashboard-gateway/v1}"
EXPECTED_TRADE_ID="${DASHBOARD_PARITY_EXPECTED_TRADE_ID:-TRD-LOCAL-9001}"

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FINISHED_AT=""
COTSEL_COMMIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
DASHBOARD_COMMIT_SHA=""
PARITY_FIXTURE_MODE="unset"

validate_env_status="not_run"
local_dev_build_status="not_run"
local_dev_up_status="not_run"
local_dev_health_status="not_run"
escrow_deploy_status="not_run"
session_mint_status="not_run"
dashboard_parity_gate_status="not_run"
dash_repo_prepare_status="not_run"
dash_live_suite_status="not_run"
local_dev_teardown_status="not_run"

OVERALL_STATUS="fail"
BLOCKING_FAILURE_CLASS=""
BLOCKING_FAILURE_STEP=""
BLOCKING_FAILURE_EXIT_CODE=""
WHOLE_PROFILE_HEALTH_ADVISORY="true"
WHOLE_PROFILE_HEALTH_NOTE=""
TEARDOWN_REQUESTED="false"

mkdir -p "$REPORT_DIR" "$LOG_DIR"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

load_env_file "$ROOT_DIR/.env"
load_env_file "$ROOT_DIR/.env.local"

if [[ -z "${DASHBOARD_SMOKE_PRIVATE_KEY:-}" && -n "${ORACLE_PRIVATE_KEY:-}" ]]; then
  export DASHBOARD_SMOKE_PRIVATE_KEY="$ORACLE_PRIVATE_KEY"
fi

PARITY_FIXTURE_MODE="${LOCAL_DEV_INDEXER_FIXTURE_MODE:-unset}"

export DASHBOARD_SMOKE_AUTH_BASE_URL="${DASHBOARD_SMOKE_AUTH_BASE_URL:-$AUTH_BASE_URL}"
export DASHBOARD_SMOKE_SESSION_OUTPUT_FILE="$SESSION_FILE"
export DASHBOARD_PARITY_AUTH_BASE_URL="$AUTH_BASE_URL"
export DASHBOARD_PARITY_GATEWAY_BASE_URL="$GATEWAY_BASE_URL"
export DASHBOARD_PARITY_SESSION_FILE="$SESSION_FILE"
export DASHBOARD_PARITY_EXPECTED_TRADE_ID="$EXPECTED_TRADE_ID"
export DASHBOARD_GATEWAY_SESSION_FILE="$SESSION_FILE"
export VITE_AUTH_BASE_URL="${VITE_AUTH_BASE_URL:-$AUTH_BASE_URL}"
export VITE_API_DASHBOARD_GATEWAY_BASE_URL="${VITE_API_DASHBOARD_GATEWAY_BASE_URL:-$GATEWAY_BASE_URL}"

validate_local_env() {
  "$ROOT_DIR/scripts/validate-env.sh" local-dev
}

build_local_dev() {
  "$ROOT_DIR/scripts/docker-services.sh" build local-dev
}

up_local_dev() {
  "$ROOT_DIR/scripts/docker-services.sh" up local-dev
}

health_local_dev() {
  "$ROOT_DIR/scripts/docker-services.sh" health local-dev
}

mint_dashboard_session() {
  (
    cd "$ROOT_DIR"
    npm run dashboard:parity:session
  )
}

run_dashboard_parity_gate() {
  (
    cd "$ROOT_DIR"
    npm run dashboard:parity:gate
  )
}

write_report() {
  REPORT_FILE="$REPORT_FILE" \
  STARTED_AT="$STARTED_AT" \
  FINISHED_AT="$FINISHED_AT" \
  COTSEL_COMMIT_SHA="$COTSEL_COMMIT_SHA" \
  DASHBOARD_COMMIT_SHA="$DASHBOARD_COMMIT_SHA" \
  DASHBOARD_REPO_DIR="$DASHBOARD_REPO_DIR" \
  COTSEL_ROOT_DIR="$ROOT_DIR" \
  AUTH_BASE_URL="$AUTH_BASE_URL" \
  GATEWAY_BASE_URL="$GATEWAY_BASE_URL" \
  EXPECTED_TRADE_ID="$EXPECTED_TRADE_ID" \
  PARITY_FIXTURE_MODE="$PARITY_FIXTURE_MODE" \
  SESSION_FILE="$SESSION_FILE" \
  OVERALL_STATUS="$OVERALL_STATUS" \
  BLOCKING_FAILURE_CLASS="$BLOCKING_FAILURE_CLASS" \
  BLOCKING_FAILURE_STEP="$BLOCKING_FAILURE_STEP" \
  BLOCKING_FAILURE_EXIT_CODE="$BLOCKING_FAILURE_EXIT_CODE" \
  WHOLE_PROFILE_HEALTH_ADVISORY="$WHOLE_PROFILE_HEALTH_ADVISORY" \
  WHOLE_PROFILE_HEALTH_NOTE="$WHOLE_PROFILE_HEALTH_NOTE" \
  LOG_DIR="$LOG_DIR" \
  validate_env_status="$validate_env_status" \
  local_dev_build_status="$local_dev_build_status" \
  local_dev_up_status="$local_dev_up_status" \
  local_dev_health_status="$local_dev_health_status" \
  escrow_deploy_status="$escrow_deploy_status" \
  session_mint_status="$session_mint_status" \
  dashboard_parity_gate_status="$dashboard_parity_gate_status" \
  dash_repo_prepare_status="$dash_repo_prepare_status" \
  dash_live_suite_status="$dash_live_suite_status" \
  local_dev_teardown_status="$local_dev_teardown_status" \
  node <<'NODE'
import fs from "node:fs";
import path from "node:path";

const optional = (name) => {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const report = {
  ok: process.env.OVERALL_STATUS === "pass",
  startedAt: process.env.STARTED_AT,
  finishedAt: process.env.FINISHED_AT,
  profile: "local-dev",
  parityFixtureMode: process.env.PARITY_FIXTURE_MODE,
  expectedTradeId: process.env.EXPECTED_TRADE_ID,
  endpoints: {
    authBaseUrl: process.env.AUTH_BASE_URL,
    gatewayBaseUrl: process.env.GATEWAY_BASE_URL,
  },
  repos: {
    cotsel: {
      path: process.env.COTSEL_ROOT_DIR,
      commitSha: optional("COTSEL_COMMIT_SHA"),
    },
    cotselDash: {
      path: process.env.DASHBOARD_REPO_DIR,
      commitSha: optional("DASHBOARD_COMMIT_SHA"),
    },
  },
  artifacts: {
    sessionFile: process.env.SESSION_FILE,
    logsDir: process.env.LOG_DIR,
  },
  statuses: {
    validateEnv: process.env.validate_env_status,
    localDevBuild: process.env.local_dev_build_status,
    localDevUp: process.env.local_dev_up_status,
    localDevHealth: process.env.local_dev_health_status,
    escrowDeploy: process.env.escrow_deploy_status,
    sessionMint: process.env.session_mint_status,
    dashboardParityGate: process.env.dashboard_parity_gate_status,
    dashRepoPrepare: process.env.dash_repo_prepare_status,
    dashLiveSuite: process.env.dash_live_suite_status,
    localDevTeardown: process.env.local_dev_teardown_status,
  },
  summary: {
    wholeProfileHealth: {
      status: process.env.local_dev_health_status,
      advisory: process.env.WHOLE_PROFILE_HEALTH_ADVISORY === "true",
      note: optional("WHOLE_PROFILE_HEALTH_NOTE"),
    },
    dashboardParityGate: process.env.dashboard_parity_gate_status,
    dashLiveSuite: process.env.dash_live_suite_status,
    overallLiveParityGate: process.env.OVERALL_STATUS,
  },
  blockingFailure: optional("BLOCKING_FAILURE_CLASS")
    ? {
        classification: process.env.BLOCKING_FAILURE_CLASS,
        step: optional("BLOCKING_FAILURE_STEP"),
        exitCode: optional("BLOCKING_FAILURE_EXIT_CODE")
          ? Number(process.env.BLOCKING_FAILURE_EXIT_CODE)
          : null,
      }
    : null,
};

fs.mkdirSync(path.dirname(process.env.REPORT_FILE), { recursive: true });
fs.writeFileSync(process.env.REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
NODE
}

print_summary() {
  cat <<EOF
Dashboard live parity summary
  whole-profile local-dev health: ${local_dev_health_status}
  dashboard parity gate: ${dashboard_parity_gate_status}
  dash live suite: ${dash_live_suite_status}
  overall live parity gate: ${OVERALL_STATUS}
  report: ${REPORT_FILE}
EOF

  if [[ -n "$WHOLE_PROFILE_HEALTH_NOTE" ]]; then
    echo "  advisory: ${WHOLE_PROFILE_HEALTH_NOTE}"
  fi

  if [[ -n "$BLOCKING_FAILURE_CLASS" ]]; then
    echo "  blocking failure: ${BLOCKING_FAILURE_CLASS} (${BLOCKING_FAILURE_STEP})"
  fi
}

run_step() {
  local step="$1"
  local status_var="$2"
  local failure_class="$3"
  shift 3

  local log_file="$LOG_DIR/${step}.log"
  echo "[${step}] command: $*" | tee -a "$LOG_DIR/summary.log"

  set +e
  "$@" > >(tee "$log_file") 2> >(tee -a "$log_file" >&2)
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    printf -v "$status_var" '%s' "pass"
    return 0
  fi

  printf -v "$status_var" '%s' "fail"
  BLOCKING_FAILURE_CLASS="$failure_class"
  BLOCKING_FAILURE_STEP="$step"
  BLOCKING_FAILURE_EXIT_CODE="$status"
  return "$status"
}

run_advisory_step() {
  local step="$1"
  local status_var="$2"
  shift 2

  local log_file="$LOG_DIR/${step}.log"
  echo "[${step}] command: $*" | tee -a "$LOG_DIR/summary.log"

  set +e
  "$@" > >(tee "$log_file") 2> >(tee -a "$log_file" >&2)
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    printf -v "$status_var" '%s' "pass"
    return 0
  fi

  printf -v "$status_var" '%s' "fail"
  return "$status"
}

deploy_escrow_contract() {
  (
    cd "$ROOT_DIR/contracts"
    npx hardhat ignition deploy ./ignition/modules/AgroasysEscrow.ts --network localhost
  )
}

prepare_dash_repo() {
  (
    cd "$DASHBOARD_REPO_DIR"
    npm ci
    npx playwright install --with-deps chromium
  )
}

run_dash_live_suite() {
  (
    cd "$DASHBOARD_REPO_DIR"
    npm run test:e2e:live
  )
}

teardown_local_dev() {
  "$ROOT_DIR/scripts/docker-services.sh" down local-dev
}

cleanup() {
  local exit_code=$?
  FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if [[ "$TEARDOWN_REQUESTED" == "true" ]]; then
    set +e
    teardown_local_dev > >(tee "$LOG_DIR/local-dev-teardown.log") 2> >(tee -a "$LOG_DIR/local-dev-teardown.log" >&2)
    local teardown_status=$?
    set -e
    if [[ "$teardown_status" -eq 0 ]]; then
      local_dev_teardown_status="pass"
    else
      local_dev_teardown_status="fail"
    fi
  fi

  if [[ "$exit_code" -eq 0 && -z "$BLOCKING_FAILURE_CLASS" ]]; then
    OVERALL_STATUS="pass"
  fi

  write_report
  print_summary
}

trap cleanup EXIT

main() {
  if [[ "$PARITY_FIXTURE_MODE" != "dashboard-parity" ]]; then
    BLOCKING_FAILURE_CLASS="env_invalid"
    BLOCKING_FAILURE_STEP="parity-fixture-mode"
    BLOCKING_FAILURE_EXIT_CODE="1"
    echo "LOCAL_DEV_INDEXER_FIXTURE_MODE must be dashboard-parity; received '${PARITY_FIXTURE_MODE}'" >&2
    return 1
  fi

  if [[ -z "${DASHBOARD_SMOKE_PRIVATE_KEY:-}" ]]; then
    BLOCKING_FAILURE_CLASS="env_invalid"
    BLOCKING_FAILURE_STEP="dashboard-smoke-private-key"
    BLOCKING_FAILURE_EXIT_CODE="1"
    echo "DASHBOARD_SMOKE_PRIVATE_KEY is required; export it explicitly or provide ORACLE_PRIVATE_KEY in .env" >&2
    return 1
  fi

  if [[ ! -d "$DASHBOARD_REPO_DIR" || ! -f "$DASHBOARD_REPO_DIR/package.json" ]]; then
    BLOCKING_FAILURE_CLASS="dash_repo_prepare_failed"
    BLOCKING_FAILURE_STEP="dash-repo-check"
    BLOCKING_FAILURE_EXIT_CODE="1"
    echo "Cotsel-Dash repository not found at ${DASHBOARD_REPO_DIR}" >&2
    return 1
  fi

  DASHBOARD_COMMIT_SHA="$(git -C "$DASHBOARD_REPO_DIR" rev-parse HEAD 2>/dev/null || true)"

  run_step "validate-env" validate_env_status "env_invalid" validate_local_env
  run_step "local-dev-build" local_dev_build_status "local_dev_start_failed" build_local_dev

  TEARDOWN_REQUESTED="true"
  run_step "local-dev-up" local_dev_up_status "local_dev_start_failed" up_local_dev

  if ! run_advisory_step "local-dev-health" local_dev_health_status health_local_dev; then
    WHOLE_PROFILE_HEALTH_NOTE="whole-profile local-dev health failed outside the narrower dashboard parity boundary"
  fi

  run_step "escrow-deploy" escrow_deploy_status "escrow_deploy_failed" deploy_escrow_contract
  run_step "session-mint" session_mint_status "session_mint_failed" mint_dashboard_session
  run_step "dashboard-parity-gate" dashboard_parity_gate_status "dashboard_parity_gate_failed" run_dashboard_parity_gate
  run_step "dash-repo-prepare" dash_repo_prepare_status "dash_repo_prepare_failed" prepare_dash_repo
  run_step "dash-live-suite" dash_live_suite_status "dash_live_suite_failed" run_dash_live_suite
}

main
