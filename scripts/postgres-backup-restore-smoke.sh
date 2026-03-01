#!/usr/bin/env bash
set -euo pipefail

POSTGRES_IMAGE="${POSTGRES_SMOKE_IMAGE:-postgres:16-alpine}"
POSTGRES_USER="${POSTGRES_SMOKE_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_SMOKE_PASSWORD:-postgres}"
SOURCE_DB="${POSTGRES_SMOKE_SOURCE_DB:-agroasys_smoke_test_source}"
TARGET_DB="${POSTGRES_SMOKE_TARGET_DB:-agroasys_smoke_test_target}"
REPORT_DIR="${POSTGRES_SMOKE_REPORT_DIR:-reports/postgres-recovery}"
RUN_ID="${POSTGRES_SMOKE_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
POSTGRES_READY_TIMEOUT="${POSTGRES_SMOKE_READY_TIMEOUT:-60}"

SRC_CONTAINER="agroasys-postgres-smoke-src-${RUN_ID}"
DST_CONTAINER="agroasys-postgres-smoke-dst-${RUN_ID}"
SENTINEL_TABLE="recovery_sentinel"
SENTINEL_ID="1"
SENTINEL_MARKER="agroasys-postgres-recovery-smoke"

LOG_FILE="${REPORT_DIR}/backup-restore-smoke.log"
REPORT_FILE="${REPORT_DIR}/backup-restore-smoke.json"
DUMP_FILE="${REPORT_DIR}/backup-restore-smoke.sql"

REPORT_WRITTEN=0
FAIL_REASON=""

mkdir -p "$REPORT_DIR"
: > "$LOG_FILE"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

write_report() {
  local pass_value="$1"
  local reason_value="$2"

  export SMOKE_PASS="$pass_value"
  export SMOKE_REASON="$reason_value"
  export SMOKE_GENERATED_AT
  SMOKE_GENERATED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  export SMOKE_REPORT_VERSION="1"
  export SMOKE_POSTGRES_IMAGE="$POSTGRES_IMAGE"
  export SMOKE_SOURCE_DB="$SOURCE_DB"
  export SMOKE_TARGET_DB="$TARGET_DB"
  export SMOKE_SENTINEL_TABLE="$SENTINEL_TABLE"
  export SMOKE_SENTINEL_ID="$SENTINEL_ID"
  export SMOKE_SENTINEL_MARKER="$SENTINEL_MARKER"
  export SMOKE_DUMP_FILE="$DUMP_FILE"
  export SMOKE_LOG_FILE="$LOG_FILE"

  python3 - "$REPORT_FILE" <<'PY'
import json
import os
import sys

out_path = sys.argv[1]
pass_value = os.environ["SMOKE_PASS"].lower() == "true"
reason_value = os.environ.get("SMOKE_REASON", "")

data = {
    "reportVersion": int(os.environ["SMOKE_REPORT_VERSION"]),
    "generatedAt": os.environ["SMOKE_GENERATED_AT"],
    "pass": pass_value,
    "reason": reason_value if reason_value else None,
    "postgresImage": os.environ["SMOKE_POSTGRES_IMAGE"],
    "sourceDatabase": os.environ["SMOKE_SOURCE_DB"],
    "targetDatabase": os.environ["SMOKE_TARGET_DB"],
    "sentinel": {
        "table": os.environ["SMOKE_SENTINEL_TABLE"],
        "id": int(os.environ["SMOKE_SENTINEL_ID"]),
        "marker": os.environ["SMOKE_SENTINEL_MARKER"],
    },
    "artifacts": {
        "dumpFile": os.environ["SMOKE_DUMP_FILE"],
        "logFile": os.environ["SMOKE_LOG_FILE"],
    },
}

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
}

cleanup() {
  docker rm -f "$SRC_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$DST_CONTAINER" >/dev/null 2>&1 || true
}

on_error() {
  local line="$1"
  local reason="${FAIL_REASON:-command failed at line ${line}}"
  log "smoke failed: ${reason}"
  if [[ "$REPORT_WRITTEN" -eq 0 ]]; then
    write_report "false" "$reason"
    REPORT_WRITTEN=1
  fi
}

trap cleanup EXIT
trap 'on_error "$LINENO"' ERR

wait_for_postgres() {
  local container_name="$1"
  local db_name="$2"
  local attempt

  for attempt in $(seq 1 "$POSTGRES_READY_TIMEOUT"); do
    if docker exec "$container_name" pg_isready -U "$POSTGRES_USER" -d "$db_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  FAIL_REASON="postgres readiness timeout for container=${container_name} db=${db_name}"
  return 1
}

run_psql() {
  local container_name="$1"
  local db_name="$2"
  shift 2
  docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db_name" "$@"
}

run_psql_with_stdin() {
  local container_name="$1"
  local db_name="$2"
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db_name"
}

wait_for_database() {
  local container_name="$1"
  local db_name="$2"
  local attempt

  for attempt in $(seq 1 "$POSTGRES_READY_TIMEOUT"); do
    if run_psql "$container_name" "$db_name" -Atc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  FAIL_REASON="database readiness timeout for container=${container_name} db=${db_name}"
  return 1
}

run_psql_retry() {
  local container_name="$1"
  local db_name="$2"
  local attempts="$3"
  shift 3
  local attempt

  for attempt in $(seq 1 "$attempts"); do
    if run_psql "$container_name" "$db_name" "$@" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$attempt" -lt "$attempts" ]]; then
      sleep 1
    fi
  done

  FAIL_REASON="psql command failed for container=${container_name} db=${db_name} after ${attempts} attempt(s)"
  return 1
}

restore_dump_retry() {
  local container_name="$1"
  local db_name="$2"
  local dump_file="$3"
  local attempts="$4"
  local attempt

  for attempt in $(seq 1 "$attempts"); do
    if run_psql_with_stdin "$container_name" "$db_name" < "$dump_file" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$attempt" -lt "$attempts" ]]; then
      sleep 1
    fi
  done

  FAIL_REASON="backup restore failed for container=${container_name} db=${db_name} after ${attempts} attempt(s)"
  return 1
}

validate_sentinel_sql_inputs() {
  if [[ ! "$SENTINEL_TABLE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    FAIL_REASON="invalid sentinel table name: ${SENTINEL_TABLE}"
    return 1
  fi

  if [[ ! "$SENTINEL_ID" =~ ^[0-9]+$ ]]; then
    FAIL_REASON="invalid sentinel id: ${SENTINEL_ID}"
    return 1
  fi

  return 0
}

log "starting postgres backup/restore smoke (runId=${RUN_ID}, image=${POSTGRES_IMAGE})"

if ! command -v docker >/dev/null 2>&1; then
  FAIL_REASON="docker CLI is not installed"
  false
fi

if ! docker info >/dev/null 2>&1; then
  FAIL_REASON="docker daemon is not available"
  false
fi

if [[ ! "$POSTGRES_READY_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  FAIL_REASON="POSTGRES_SMOKE_READY_TIMEOUT must be a positive integer (received: ${POSTGRES_READY_TIMEOUT})"
  false
fi

docker run -d \
  --name "$SRC_CONTAINER" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB="$SOURCE_DB" \
  "$POSTGRES_IMAGE" >/dev/null

wait_for_postgres "$SRC_CONTAINER" "$SOURCE_DB"
wait_for_database "$SRC_CONTAINER" "$SOURCE_DB"

validate_sentinel_sql_inputs

log "source postgres ready; creating sentinel row"
run_psql_retry "$SRC_CONTAINER" "$SOURCE_DB" 10 \
  -c "CREATE TABLE IF NOT EXISTS ${SENTINEL_TABLE} (id INTEGER PRIMARY KEY, marker TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" \
  -c "INSERT INTO ${SENTINEL_TABLE} (id, marker) VALUES (${SENTINEL_ID}, '${SENTINEL_MARKER}') ON CONFLICT (id) DO UPDATE SET marker = EXCLUDED.marker;"

log "creating logical backup dump"
if docker exec "$SRC_CONTAINER" pg_dump --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" "$SOURCE_DB" > "$DUMP_FILE" 2>>"$LOG_FILE"; then
  :
else
  pg_dump_status=$?
  FAIL_REASON="pg_dump failed with exit code ${pg_dump_status}; see log file for details"
  false
fi
if [[ ! -s "$DUMP_FILE" ]]; then
  FAIL_REASON="backup dump file is empty (${DUMP_FILE})"
  false
fi

docker run -d \
  --name "$DST_CONTAINER" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB="$TARGET_DB" \
  "$POSTGRES_IMAGE" >/dev/null

wait_for_postgres "$DST_CONTAINER" "$TARGET_DB"
wait_for_database "$DST_CONTAINER" "$TARGET_DB"

log "restoring backup into target postgres"
restore_dump_retry "$DST_CONTAINER" "$TARGET_DB" "$DUMP_FILE" 10

RESTORED_MARKER="$(run_psql "$DST_CONTAINER" "$TARGET_DB" -Atc "SELECT marker FROM ${SENTINEL_TABLE} WHERE id=${SENTINEL_ID};")"
if [[ "$RESTORED_MARKER" != "$SENTINEL_MARKER" ]]; then
  FAIL_REASON="restored sentinel marker mismatch (expected=${SENTINEL_MARKER}, actual=${RESTORED_MARKER:-<empty>})"
  false
fi

log "restored sentinel verified successfully"
write_report "true" ""
REPORT_WRITTEN=1
log "smoke completed successfully; report=${REPORT_FILE}"
