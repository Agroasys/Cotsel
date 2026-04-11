#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="live"
BRING_UP_PROFILE="false"
WINDOW_ID=""
PROFILE="staging-e2e-real"
REPORT_ROOT="${PILOT_REHEARSAL_REPORT_ROOT:-$ROOT_DIR/reports/base-sepolia-pilot-validation}"
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FINISHED_AT=""
TEMP_BASE_ENV_CREATED="false"
TEMP_PROFILE_ENV_CREATED="false"

validate_env_status="not_run"
profile_up_status="not_run"
profile_health_status="not_run"
staging_gate_status="not_run"
notifications_build_status="not_run"
notifications_gate_status="not_run"

OVERALL_STATUS="fail"
MANUAL_EVIDENCE_STATUS="pending"
BLOCKING_FAILURE_CLASS=""
BLOCKING_FAILURE_STEP=""
BLOCKING_FAILURE_EXIT_CODE=""

usage() {
  cat <<'EOF' >&2
Usage: scripts/base-sepolia-pilot-validation.sh --window-id <id> [--config-only] [--bring-up-profile]

Options:
  --window-id <id>       Deterministic pilot window identifier, for example PILOT-2026-03-31
  --config-only          Validate the rehearsal contract without claiming a live run
  --bring-up-profile     Explicitly run docker-services up staging-e2e-real before live checks
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window-id)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      WINDOW_ID="$2"
      shift 2
      ;;
    --config-only)
      MODE="config-only"
      shift
      ;;
    --bring-up-profile)
      BRING_UP_PROFILE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$WINDOW_ID" ]]; then
  echo "--window-id is required" >&2
  usage
  exit 1
fi

if [[ ! "$WINDOW_ID" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  echo "window id contains invalid characters: $WINDOW_ID" >&2
  exit 1
fi

REPORT_DIR="$REPORT_ROOT/$WINDOW_ID"
LOG_DIR="$REPORT_DIR/logs"
SUMMARY_FILE="$REPORT_DIR/summary.json"
GATE_OUTPUT_FILE="$REPORT_DIR/gate-output.txt"
BLOCKERS_FILE="$REPORT_DIR/blockers.md"
MANUAL_CHECKLIST_FILE="$REPORT_DIR/manual-checklist.md"
TX_LINKS_FILE="$REPORT_DIR/tx-links.md"
SIGNOFF_FILE="$REPORT_DIR/signoff.md"
NOTIFICATIONS_REPORT_SOURCE="$ROOT_DIR/reports/notifications/${PROFILE}.json"
RECONCILIATION_REPORT_SOURCE="$ROOT_DIR/reports/reconciliation/${PROFILE}-report.json"
NOTIFICATIONS_REPORT_TARGET="$REPORT_DIR/notifications-report.json"
RECONCILIATION_REPORT_TARGET="$REPORT_DIR/reconciliation-report.json"
SUMMARY_LOG="$LOG_DIR/summary.log"

mkdir -p "$REPORT_DIR" "$LOG_DIR"
: > "$SUMMARY_LOG"

run_step() {
  local step="$1"
  local status_var="$2"
  local failure_class="$3"
  shift 3

  local log_file="$LOG_DIR/${step}.log"
  echo "[${step}] command: $*" | tee -a "$SUMMARY_LOG"

  set +e
  "$@" > >(tee "$log_file") 2> >(tee -a "$log_file" >&2)
  local status=$?
  set -e

  cat "$log_file" >> "$GATE_OUTPUT_FILE"
  printf '\n' >> "$GATE_OUTPUT_FILE"

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

copy_if_present() {
  local source="$1"
  local target="$2"
  if [[ -f "$source" ]]; then
    cp "$source" "$target"
  fi
}

print_summary() {
  cat <<EOF
Base Sepolia pilot rehearsal summary
  window: $WINDOW_ID
  mode: $MODE
  validate env: $validate_env_status
  profile health: $profile_health_status
  staging gate: $staging_gate_status
  notifications build: $notifications_build_status
  notifications gate: $notifications_gate_status
  overall: $OVERALL_STATUS
  manual evidence: $MANUAL_EVIDENCE_STATUS
  report dir: $REPORT_DIR
EOF
  if [[ -n "$BLOCKING_FAILURE_CLASS" ]]; then
    echo "  blocking failure: $BLOCKING_FAILURE_CLASS ($BLOCKING_FAILURE_STEP)"
  fi
}

write_templates() {
  cat > "$BLOCKERS_FILE" <<EOF
# Blocker Register

Window: \`$WINDOW_ID\`
Mode: \`$MODE\`

Populate one row per unresolved blocker discovered during the rehearsal.

| Severity | Area | Blocking condition | Evidence | Owner | Decision / next action |
|---|---|---|---|---|---|
| \`P0/P1/P2\` | \`gateway/oracle/reconciliation/treasury/docs/ops\` | \<describe blocker\> | \<path or URL\> | \<owner\> | \<fix / accepted narrower scope / defer\> |
EOF

  cat > "$MANUAL_CHECKLIST_FILE" <<EOF
# Manual Rehearsal Checklist

Window: \`$WINDOW_ID\`
Mode: \`$MODE\`

Complete every section below during the live Base Sepolia rehearsal.

- [ ] Buyer lock evidence captured
  - txHash:
  - tradeId:
  - evidence path:
- [ ] Oracle release evidence captured
  - txHash:
  - trigger type:
  - evidence path:
- [ ] Dispute or hold path captured
  - txHash or operator record:
  - evidence path:
- [ ] Reconciliation result captured
  - run key:
  - report path:
- [ ] Treasury ingest/export or freeze-control observation captured
  - evidence path:
- [ ] Dashboard operator path observation captured
  - evidence path:
- [ ] Operator observations and anomalies recorded
  - notes:
EOF

  cat > "$TX_LINKS_FILE" <<EOF
# Transaction Links

Window: \`$WINDOW_ID\`

Record Base explorer links and supporting transaction references here.

| Lifecycle step | tradeId | txHash | Explorer URL | Notes |
|---|---|---|---|---|
| buyer lock | | | | |
| oracle release | | | | |
| dispute or hold | | | | |
| treasury or freeze control | | | | |
EOF

  cat > "$SIGNOFF_FILE" <<EOF
# Signoff Summary

Window: \`$WINDOW_ID\`
Mode: \`$MODE\`

## Role ownership
- Pilot Owner: Aston (pilot default)
- On-call Engineer: Platform On-Call
- Service Owner: name the owning maintainer for the in-scope subsystem here

## Evidence packet location
- In-repo sanitized packet path:
- External live packet path (if required):
- Redaction decision:

## Pass / Fail
- Overall result:
- Unresolved P0 blockers:
- Narrower accepted scope decision (if any):

## Approvals
- Pilot Owner:
- On-call Engineer:
- Service Owner:
EOF
}

write_blockers() {
  if [[ -n "$BLOCKING_FAILURE_CLASS" ]]; then
    cat > "$BLOCKERS_FILE" <<EOF
# Blocker Register

Window: \`$WINDOW_ID\`
Mode: \`$MODE\`

| Severity | Area | Blocking condition | Evidence | Owner | Decision / next action |
|---|---|---|---|---|---|
| \`P0\` | \`ops\` | \`$BLOCKING_FAILURE_CLASS\` at step \`$BLOCKING_FAILURE_STEP\` blocked the rehearsal before closure evidence could be captured. | \`$REPORT_DIR/summary.json\` | \`Pilot Owner / Service Owner\` | Record the concrete managed-provider / runtime fix, rerun the rehearsal, and update signoff. |
EOF
    return
  fi

  cat > "$BLOCKERS_FILE" <<EOF
# Blocker Register

Window: \`$WINDOW_ID\`
Mode: \`$MODE\`

Populate one row per unresolved blocker discovered during the rehearsal.

| Severity | Area | Blocking condition | Evidence | Owner | Decision / next action |
|---|---|---|---|---|---|
| \`P0/P1/P2\` | \`gateway/oracle/reconciliation/treasury/docs/ops\` | \<describe blocker\> | \<path or URL\> | \<owner\> | \<fix / accepted narrower scope / defer\> |
EOF
}

cleanup_temp_env() {
  if [[ "$TEMP_BASE_ENV_CREATED" == "true" && -f "$ROOT_DIR/.env" ]]; then
    rm -f "$ROOT_DIR/.env"
  fi
  if [[ "$TEMP_PROFILE_ENV_CREATED" == "true" && -f "$ROOT_DIR/.env.staging-e2e-real" ]]; then
    rm -f "$ROOT_DIR/.env.staging-e2e-real"
  fi
}

trap cleanup_temp_env EXIT

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

ORIGINAL_ENV_KEYS=()
ORIGINAL_ENV_VALUES=()
while IFS='=' read -r key value; do
  ORIGINAL_ENV_KEYS+=("$key")
  ORIGINAL_ENV_VALUES+=("$value")
done < <(env)

restore_external_environment_overrides() {
  local idx=0
  for key in "${ORIGINAL_ENV_KEYS[@]}"; do
    export "$key=${ORIGINAL_ENV_VALUES[$idx]}"
    idx=$((idx + 1))
  done
}

contains_retired_runtime_marker() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == *legacy* || "$value" == *retired* || "$value" == *archive* || "$value" == *deprecated* ]]
}

contains_placeholder_value() {
  local value="${1:-}"
  [[ "$value" == *example.invalid* || "$value" == *example.com* || "$value" == *placeholder* || "$value" == *changeme* ]]
}

is_zero_address() {
  [[ "${1:-}" =~ ^0x0{40}$ ]]
}

is_public_base_rpc() {
  local value="${1:-}"
  [[ "$value" == "https://sepolia.base.org" || "$value" == "https://mainnet.base.org" || "$value" == "https://sepolia-preconf.base.org" || "$value" == "https://mainnet-preconf.base.org" ]]
}

fail_live_preflight() {
  local classification="$1"
  local step="$2"
  local message="$3"
  BLOCKING_FAILURE_CLASS="$classification"
  BLOCKING_FAILURE_STEP="$step"
  BLOCKING_FAILURE_EXIT_CODE="2"
  echo "$message" >&2
  return 1
}

validate_pilot_profile_truth() {
  load_env_file "$ROOT_DIR/.env"
  restore_external_environment_overrides
  load_env_file "$ROOT_DIR/.env.staging-e2e-real"
  restore_external_environment_overrides

  if [[ "${STAGING_E2E_REAL_NETWORK_NAME:-}" != "Base Sepolia" ]]; then
    fail_live_preflight "PILOT_PROFILE_NOT_BASE_SEPOLIA" "pilot-profile-truth" "STAGING_E2E_REAL_NETWORK_NAME must be 'Base Sepolia'."
    return 1
  fi

  if [[ "${STAGING_E2E_REAL_CHAIN_ID:-}" != "84532" ]]; then
    fail_live_preflight "PILOT_PROFILE_CHAIN_ID_MISMATCH" "pilot-profile-truth" "STAGING_E2E_REAL_CHAIN_ID must be 84532."
    return 1
  fi

  for pair in \
    "INDEXER_GATEWAY_URL:${INDEXER_GATEWAY_URL:-}" \
    "INDEXER_RPC_ENDPOINT:${INDEXER_RPC_ENDPOINT:-}" \
    "GATEWAY_RPC_URL:${GATEWAY_RPC_URL:-}" \
    "ORACLE_RPC_URL:${ORACLE_RPC_URL:-}" \
    "RECONCILIATION_RPC_URL:${RECONCILIATION_RPC_URL:-}"
  do
    name="${pair%%:*}"
    value="${pair#*:}"
    if contains_retired_runtime_marker "$value"; then
      fail_live_preflight "HISTORICAL_CHAIN_VALUE_PRESENT" "$name" "$name still points at historical chain infrastructure: $value"
      return 1
    fi
  done

  for pair in \
    "GATEWAY_SETTLEMENT_RUNTIME:${GATEWAY_SETTLEMENT_RUNTIME:-}" \
    "ORACLE_SETTLEMENT_RUNTIME:${ORACLE_SETTLEMENT_RUNTIME:-}" \
    "RECONCILIATION_SETTLEMENT_RUNTIME:${RECONCILIATION_SETTLEMENT_RUNTIME:-}"
  do
    name="${pair%%:*}"
    value="${pair#*:}"
    if [[ -n "$value" && "$value" != "base-sepolia" ]]; then
      fail_live_preflight "PILOT_RUNTIME_KEY_MISMATCH" "$name" "$name must be base-sepolia for the controlled Base Sepolia rehearsal."
      return 1
    fi
  done

  for pair in \
    "GATEWAY_CHAIN_ID:${GATEWAY_CHAIN_ID:-}" \
    "ORACLE_CHAIN_ID:${ORACLE_CHAIN_ID:-}" \
    "RECONCILIATION_CHAIN_ID:${RECONCILIATION_CHAIN_ID:-}"
  do
    name="${pair%%:*}"
    value="${pair#*:}"
    if [[ -n "$value" && "$value" != "84532" ]]; then
      fail_live_preflight "PILOT_CHAIN_ID_MISMATCH" "$name" "$name must be 84532 for the controlled Base Sepolia rehearsal."
      return 1
    fi
  done
}

validate_live_managed_provider_inputs() {
  for pair in \
    "INDEXER_GATEWAY_URL:${INDEXER_GATEWAY_URL:-}" \
    "INDEXER_RPC_ENDPOINT:${INDEXER_RPC_ENDPOINT:-}" \
    "GATEWAY_RPC_URL:${GATEWAY_RPC_URL:-}" \
    "ORACLE_RPC_URL:${ORACLE_RPC_URL:-}" \
    "RECONCILIATION_RPC_URL:${RECONCILIATION_RPC_URL:-}"
  do
    name="${pair%%:*}"
    value="${pair#*:}"
    if [[ -z "$value" ]]; then
      fail_live_preflight "LIVE_MANAGED_PROVIDER_CONFIG_REQUIRED" "$name" "$name must be set to a real managed Base Sepolia provider URL."
      return 1
    fi
    if contains_placeholder_value "$value"; then
      fail_live_preflight "LIVE_MANAGED_PROVIDER_CONFIG_REQUIRED" "$name" "$name still contains a template placeholder: $value"
      return 1
    fi
    if is_public_base_rpc "$value"; then
      fail_live_preflight "LIVE_MANAGED_PROVIDER_CONFIG_REQUIRED" "$name" "$name must not use the public Base RPC endpoint for the controlled pilot runtime."
      return 1
    fi
  done

  for pair in \
    "GATEWAY_RPC_FALLBACK_URLS:${GATEWAY_RPC_FALLBACK_URLS:-}" \
    "ORACLE_RPC_FALLBACK_URLS:${ORACLE_RPC_FALLBACK_URLS:-}" \
    "RECONCILIATION_RPC_FALLBACK_URLS:${RECONCILIATION_RPC_FALLBACK_URLS:-}"
  do
    name="${pair%%:*}"
    value="${pair#*:}"
    if [[ -z "$value" ]]; then
      fail_live_preflight "LIVE_FALLBACK_PROVIDER_REQUIRED" "$name" "$name must name an independent managed fallback provider for the controlled pilot runtime."
      return 1
    fi
    if contains_placeholder_value "$value"; then
      fail_live_preflight "LIVE_FALLBACK_PROVIDER_REQUIRED" "$name" "$name still contains a template placeholder: $value"
      return 1
    fi
    if is_public_base_rpc "$value"; then
      fail_live_preflight "LIVE_FALLBACK_PROVIDER_REQUIRED" "$name" "$name must not use the public Base RPC endpoint as the managed fallback provider."
      return 1
    fi
  done

  for pair in \
    "GATEWAY_ESCROW_ADDRESS:${GATEWAY_ESCROW_ADDRESS:-}" \
    "ORACLE_ESCROW_ADDRESS:${ORACLE_ESCROW_ADDRESS:-}" \
    "RECONCILIATION_ESCROW_ADDRESS:${RECONCILIATION_ESCROW_ADDRESS:-}" \
    "INDEXER_CONTRACT_ADDRESS:${INDEXER_CONTRACT_ADDRESS:-}"
  do
    name="${pair%%:*}"
    value="${pair#*:}"
    if [[ -z "$value" ]] || is_zero_address "$value"; then
      fail_live_preflight "LIVE_CONTRACT_ADDRESS_REQUIRED" "$name" "$name must be set to the deployed Base Sepolia escrow address before the live rehearsal."
      return 1
    fi
  done
}

write_summary() {
  SUMMARY_FILE="$SUMMARY_FILE" \
  WINDOW_ID="$WINDOW_ID" \
  MODE="$MODE" \
  STARTED_AT="$STARTED_AT" \
  FINISHED_AT="$FINISHED_AT" \
  REPORT_DIR="$REPORT_DIR" \
  PROFILE="$PROFILE" \
  OVERALL_STATUS="$OVERALL_STATUS" \
  MANUAL_EVIDENCE_STATUS="$MANUAL_EVIDENCE_STATUS" \
  BLOCKING_FAILURE_CLASS="$BLOCKING_FAILURE_CLASS" \
  BLOCKING_FAILURE_STEP="$BLOCKING_FAILURE_STEP" \
  BLOCKING_FAILURE_EXIT_CODE="$BLOCKING_FAILURE_EXIT_CODE" \
  validate_env_status="$validate_env_status" \
  profile_up_status="$profile_up_status" \
  profile_health_status="$profile_health_status" \
  staging_gate_status="$staging_gate_status" \
  notifications_build_status="$notifications_build_status" \
  notifications_gate_status="$notifications_gate_status" \
  node <<'NODE'
const fs = require("node:fs");

const optional = (name) => {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const report = {
  windowId: process.env.WINDOW_ID,
  mode: process.env.MODE,
  startedAt: process.env.STARTED_AT,
  finishedAt: process.env.FINISHED_AT,
  profile: process.env.PROFILE,
  overallStatus: process.env.OVERALL_STATUS,
  manualEvidenceStatus: process.env.MANUAL_EVIDENCE_STATUS,
  liveRehearsalExecuted:
    process.env.MODE === "live" &&
    process.env.profile_health_status !== "not_run",
  statuses: {
    validateEnv: process.env.validate_env_status,
    profileUp: process.env.profile_up_status,
    profileHealth: process.env.profile_health_status,
    stagingGate: process.env.staging_gate_status,
    notificationsBuild: process.env.notifications_build_status,
    notificationsGate: process.env.notifications_gate_status,
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
  artifacts: {
    reportDir: process.env.REPORT_DIR,
    summary: "summary.json",
    gateOutput: "gate-output.txt",
    blockers: "blockers.md",
    manualChecklist: "manual-checklist.md",
    txLinks: "tx-links.md",
    signoff: "signoff.md",
    reconciliationReport: fs.existsSync(`${process.env.REPORT_DIR}/reconciliation-report.json`)
      ? "reconciliation-report.json"
      : null,
    notificationsReport: fs.existsSync(`${process.env.REPORT_DIR}/notifications-report.json`)
      ? "notifications-report.json"
      : null,
  },
};

fs.writeFileSync(process.env.SUMMARY_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
NODE
}

: > "$GATE_OUTPUT_FILE"
write_templates
write_blockers

if [[ "$MODE" == "config-only" ]]; then
  if [[ ! -f "$ROOT_DIR/.env" ]]; then
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
    TEMP_BASE_ENV_CREATED="true"
  fi
  if [[ ! -f "$ROOT_DIR/.env.staging-e2e-real" ]]; then
    cp "$ROOT_DIR/.env.staging-e2e-real.example" "$ROOT_DIR/.env.staging-e2e-real"
    TEMP_PROFILE_ENV_CREATED="true"
  fi
fi

if ! run_step validate-env validate_env_status ENV_INVALID "$ROOT_DIR/scripts/validate-env.sh" "$PROFILE"; then
  FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_blockers
  write_summary
  print_summary
  exit 1
fi

if ! validate_pilot_profile_truth; then
  FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_blockers
  write_summary
  print_summary
  exit 1
fi

if [[ "$MODE" == "live" ]]; then
  if ! validate_live_managed_provider_inputs; then
    FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    write_blockers
    write_summary
    print_summary
    exit 1
  fi
fi

if [[ "$MODE" == "live" && "$BRING_UP_PROFILE" == "true" ]]; then
  if ! run_step profile-up profile_up_status PROFILE_UP_FAILED "$ROOT_DIR/scripts/docker-services.sh" up "$PROFILE"; then
    FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    write_blockers
    write_summary
    print_summary
    exit 1
  fi
fi

if [[ "$MODE" == "live" ]]; then
  if ! run_step profile-health profile_health_status PROFILE_HEALTH_FAILED "$ROOT_DIR/scripts/docker-services.sh" health "$PROFILE"; then
    FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    write_blockers
    write_summary
    print_summary
    exit 1
  fi
else
  profile_health_status="not_applicable"
fi

if [[ "$MODE" == "config-only" ]]; then
  if ! run_step staging-gate staging_gate_status STAGING_GATE_FAILED env STAGING_E2E_REAL_GATE_ASSERT_CONFIG_ONLY=true "$ROOT_DIR/scripts/staging-e2e-real-gate.sh"; then
    FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    write_blockers
    write_summary
    print_summary
    exit 1
  fi
else
  if ! run_step staging-gate staging_gate_status STAGING_GATE_FAILED "$ROOT_DIR/scripts/staging-e2e-real-gate.sh"; then
    FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    write_blockers
    write_summary
    print_summary
    exit 1
  fi
fi

if ! run_step notifications-build notifications_build_status NOTIFICATIONS_BUILD_FAILED npm run -w notifications build; then
  FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_blockers
  write_summary
  print_summary
  exit 1
fi

if ! run_step notifications-gate notifications_gate_status NOTIFICATIONS_GATE_FAILED "$ROOT_DIR/scripts/notifications-gate.sh" "$PROFILE"; then
  FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_blockers
  write_summary
  print_summary
  exit 1
fi

copy_if_present "$NOTIFICATIONS_REPORT_SOURCE" "$NOTIFICATIONS_REPORT_TARGET"
copy_if_present "$RECONCILIATION_REPORT_SOURCE" "$RECONCILIATION_REPORT_TARGET"

if [[ "$MODE" == "live" ]]; then
  OVERALL_STATUS="pending_manual_evidence"
  MANUAL_EVIDENCE_STATUS="pending"
else
  OVERALL_STATUS="pass"
  MANUAL_EVIDENCE_STATUS="not_applicable"
fi
FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
write_blockers
write_summary

print_summary
