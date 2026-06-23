#!/usr/bin/env bash
set -euo pipefail

# Cotsel runtime control script.
#
# One profile (`runtime`), one env file (`.env.runtime`). The same definition
# runs for local development and VM deployment — only the values in
# .env.runtime differ (RPC URL, contract address, start block, …).
#
# Usage:
#   scripts/cotsel.sh build [service]      build images (all, or one service)
#   scripts/cotsel.sh up                   start services (validate env first)
#   scripts/cotsel.sh up --gate            full validated deploy + release gate
#   scripts/cotsel.sh up --gate --skip-build   re-deploy with current images
#   scripts/cotsel.sh down                 stop + remove (with volumes)
#   scripts/cotsel.sh logs [service]       tail logs
#   scripts/cotsel.sh ps                   list services
#   scripts/cotsel.sh health               wait for + probe service health
#   scripts/cotsel.sh config               render resolved compose config
#
# See docs/runbooks/vm-deploy.md for the full VM setup procedure.

COMPOSE_FILE="docker-compose.services.yml"
PROFILE="runtime"
RUNTIME_ENV=".env.runtime"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HEALTH_RETRIES="${DOCKER_SERVICES_HEALTH_RETRIES:-15}"
HEALTH_RETRY_DELAY_SECONDS="${DOCKER_SERVICES_HEALTH_RETRY_DELAY_SECONDS:-2}"
WAIT_TIMEOUT_SECONDS="${DOCKER_SERVICES_WAIT_TIMEOUT_SECONDS:-120}"
WAIT_POLL_SECONDS="${DOCKER_SERVICES_WAIT_POLL_SECONDS:-2}"
HEALTH_LOG_TAIL_LINES="${DOCKER_SERVICES_HEALTH_LOG_TAIL_LINES:-80}"

usage() {
  echo "Usage: scripts/cotsel.sh <build|up|down|logs|ps|health|config> [service] [--gate] [--skip-build]" >&2
}

ACTION="${1:-}"
shift || true

SERVICE=""
GATE=false
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --gate) GATE=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --*)
      echo "Unknown option: $arg" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$SERVICE" ]]; then
        echo "Unexpected extra argument: $arg" >&2
        usage
        exit 1
      fi
      SERVICE="$arg"
      ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  usage
  exit 1
fi

case "$ACTION" in
  build|up|down|logs|ps|health|config) ;;
  *)
    echo "Unknown action: $ACTION" >&2
    usage
    exit 1
    ;;
esac

if [[ -n "$SERVICE" && "$ACTION" != "build" && "$ACTION" != "logs" ]]; then
  echo "Action '$ACTION' does not accept a service argument" >&2
  usage
  exit 1
fi

if [[ "$GATE" == "true" && "$ACTION" != "up" ]]; then
  echo "--gate is only valid with 'up'" >&2
  usage
  exit 1
fi

if [[ "$SKIP_BUILD" == "true" && "$GATE" != "true" ]]; then
  echo "--skip-build is only valid with 'up --gate'" >&2
  usage
  exit 1
fi

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

run_env_preflight() {
  if [[ "${DOCKER_SERVICES_SKIP_ENV_PRECHECK:-false}" == "true" ]]; then
    return 0
  fi

  case "$ACTION" in
    build|up|health|config)
      "$SCRIPT_DIR/validate-env.sh" "$PROFILE"
      ;;
  esac
}

# Preserve any externally-exported overrides so they win over file values.
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

load_runtime_env() {
  load_env_file "$RUNTIME_ENV"
  restore_external_environment_overrides
}

run_compose() {
  docker compose -f "$COMPOSE_FILE" --profile "$PROFILE" "$@"
}

container_id_for_service() {
  local service_name="$1"
  run_compose ps -q "$service_name" 2>/dev/null | head -n 1
}

container_state() {
  local container_id="$1"
  docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || echo "missing"
}

container_health() {
  local container_id="$1"
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || echo "missing"
}

print_service_diagnostics() {
  local service_name="$1"
  local container_id="$2"

  echo "diagnostics for service '$service_name' (profile=$PROFILE)" >&2
  run_compose ps "$service_name" >&2 || true

  if [[ -n "$container_id" ]]; then
    echo "container state=$(container_state "$container_id") health=$(container_health "$container_id") id=$container_id" >&2
    docker inspect -f '{{range .State.Health.Log}}{{println .End .ExitCode .Output}}{{end}}' "$container_id" 2>/dev/null >&2 || true
  fi

  run_compose logs --tail="$HEALTH_LOG_TAIL_LINES" "$service_name" >&2 || true
}

wait_until_healthy() {
  local service_name="$1"
  local timeout_seconds="$2"
  local poll_seconds="$3"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS <= deadline )); do
    local container_id
    container_id="$(container_id_for_service "$service_name")"

    if [[ -z "$container_id" ]]; then
      sleep "$poll_seconds"
      continue
    fi

    local state
    state="$(container_state "$container_id")"
    local health
    health="$(container_health "$container_id")"

    if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
      return 0
    fi

    if [[ "$state" == "exited" || "$state" == "dead" || "$health" == "unhealthy" ]]; then
      echo "required service became unhealthy before ready: $service_name (state=$state health=$health)" >&2
      print_service_diagnostics "$service_name" "$container_id"
      return 1
    fi

    sleep "$poll_seconds"
  done

  local container_id
  container_id="$(container_id_for_service "$service_name")"
  echo "required service did not become ready before timeout: $service_name (${timeout_seconds}s)" >&2
  print_service_diagnostics "$service_name" "$container_id"
  return 1
}

is_running() {
  local service_name="$1"
  local running_service
  while IFS= read -r running_service; do
    if [[ "$running_service" == "$service_name" ]]; then
      return 0
    fi
  done < <(run_compose ps --services --filter status=running)

  return 1
}

with_retries() {
  local label="$1"
  local attempt=1

  shift

  while (( attempt <= HEALTH_RETRIES )); do
    if "$@"; then
      return 0
    fi

    if (( attempt == HEALTH_RETRIES )); then
      echo "$label failed after ${HEALTH_RETRIES} attempt(s)" >&2
      return 1
    fi

    sleep "$HEALTH_RETRY_DELAY_SECONDS"
    ((attempt += 1))
  done

  return 1
}

check_http_health_once() {
  local url="$1"
  curl -fsS "$url" >/dev/null
}

check_http_health() {
  local name="$1"
  local url="$2"

  if with_retries "$name health endpoint" check_http_health_once "$url"; then
    echo "$name health endpoint: ok"
    return 0
  fi

  echo "$name health endpoint failed: $url" >&2
  return 1
}

check_http_health_in_service_once() {
  local service_name="$1"
  local port="$2"
  local path="$3"

  run_compose exec -T "$service_name" node -e "fetch('http://127.0.0.1:${port}${path}').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
}

check_http_health_in_service() {
  local name="$1"
  local service_name="$2"
  local port="$3"
  local path="$4"

  if with_retries "$name health endpoint" check_http_health_in_service_once "$service_name" "$port" "$path"; then
    echo "$name health endpoint: ok"
    return 0
  fi

  echo "$name health endpoint failed: service=$service_name path=$path" >&2
  return 1
}

check_required_services() {
  local required_services=(postgres redis indexer-pipeline indexer-graphql oracle reconciliation ricardian treasury auth gateway)

  for service_name in "${required_services[@]}"; do
    if ! wait_until_healthy "$service_name" "$WAIT_TIMEOUT_SECONDS" "$WAIT_POLL_SECONDS"; then
      return 1
    fi

    if ! is_running "$service_name"; then
      echo "required service is not running: $service_name" >&2
      echo "profile=$PROFILE compose=$COMPOSE_FILE" >&2
      echo "expected=${required_services[*]}" >&2
      echo "running=$(run_compose ps --services --filter status=running | tr '\n' ' ')" >&2
      return 1
    fi
  done

  return 0
}

check_indexer_graphql_once() {
  local graphql_port="$1"
  local graphql_path="/graphql"

  if is_running "indexer-graphql"; then
    run_compose exec -T indexer-graphql node -e "fetch('http://127.0.0.1:${graphql_port}${graphql_path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { __typename }' }) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
    return 0
  fi

  return 1
}

check_indexer_graphql() {
  local graphql_port="${INDEXER_GRAPHQL_PORT:-4350}"

  if with_retries "indexer graphql endpoint" check_indexer_graphql_once "$graphql_port"; then
    echo "indexer graphql endpoint: ok (indexer-graphql)"
    return 0
  fi

  echo "indexer graphql endpoint check failed" >&2
  return 1
}

check_reconciliation_health_once() {
  run_compose exec -T reconciliation node reconciliation/dist/healthcheck.js >/dev/null
}

run_health() {
  run_compose ps
  check_required_services

  if is_running "ricardian"; then
    check_http_health "ricardian" "http://127.0.0.1:${RICARDIAN_PORT:-3100}/api/ricardian/v1/health"
  fi

  if is_running "treasury"; then
    check_http_health "treasury" "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health"
  fi

  if is_running "oracle"; then
    check_http_health_in_service "oracle" "oracle" "${ORACLE_PORT:-3001}" "/api/oracle/health"
  fi

  if is_running "gateway"; then
    check_http_health "gateway" "http://127.0.0.1:${GATEWAY_PORT:-3600}/api/dashboard-gateway/v1/healthz"
  fi

  if is_running "auth"; then
    check_http_health "auth" "http://127.0.0.1:${AUTH_PORT:-3005}/api/auth/v1/health"
  fi

  if is_running "reconciliation"; then
    with_retries "reconciliation healthcheck" check_reconciliation_health_once
    echo "reconciliation healthcheck: ok"
  fi

  "$SCRIPT_DIR/notifications-wiring-health.sh" "$PROFILE"

  check_indexer_graphql
}

# Full validated deploy: enforce a single source of truth, validate, build,
# then run the release gate (which starts services, waits for health, and
# runs the indexer-lag / reorg / reconciliation probes).
run_gated_deploy() {
  log()  { printf '\n==> %s\n' "$*"; }
  note() { printf '    %s\n' "$*"; }
  fail() { printf '\nFAIL: %s\n\n' "$*" >&2; exit 1; }

  log "Checking deployment environment..."

  if [[ ! -f "$RUNTIME_ENV" ]]; then
    fail "$RUNTIME_ENV not found.

  Create it from the template and fill in every field:
    cp .env.runtime.example .env.runtime

  See docs/runbooks/vm-deploy.md for the complete procedure."
  fi

  # No other .env files may exist alongside .env.runtime — any stale file
  # creates ambiguity about which values are actually active.
  while IFS= read -r conflict; do
    if [[ "$conflict" == "$RUNTIME_ENV" || "$conflict" == *.example ]]; then
      continue
    fi
    fail "$conflict must not exist when deploying from $RUNTIME_ENV.
It creates ambiguity about which values are active.
Remove it:
  rm $conflict"
  done < <(find . -maxdepth 1 -type f -name '.env*' -exec basename {} \; | sort)

  note "$RUNTIME_ENV found — no conflicting env files"

  log "Validating environment variables..."
  "$SCRIPT_DIR/validate-env.sh" "$PROFILE"

  if [[ "$SKIP_BUILD" == "true" ]]; then
    log "Skipping image build (--skip-build)"
    note "Existing images will be used — rebuild without --skip-build if service code changed"
  else
    log "Building container images (profile=$PROFILE)..."
    note "First build can take several minutes"
    run_compose build
  fi

  log "Starting services and running deployment gate..."
  "$SCRIPT_DIR/runtime-gate.sh"

  log "Running services:"
  run_compose ps

  local sep
  sep="$(printf '─%.0s' {1..62})"
  printf '\n%s\n' "$sep"
  printf 'Deployment complete\n'
  printf '  profile:   %s\n' "$PROFILE"
  printf '  env file:  %s\n' "$RUNTIME_ENV"
  printf '\nOperational commands:\n'
  printf '  scripts/cotsel.sh logs [svc]   tail logs\n'
  printf '  scripts/cotsel.sh health       re-check\n'
  printf '  scripts/cotsel.sh down         stop + rm\n'
  printf '%s\n' "$sep"
}

run_env_preflight
load_runtime_env

case "$ACTION" in
  build)
    if [[ -n "$SERVICE" ]]; then
      run_compose build "$SERVICE"
    else
      run_compose build
    fi
    ;;
  up)
    if [[ "$GATE" == "true" ]]; then
      run_gated_deploy
    else
      run_compose up -d
    fi
    ;;
  down)
    run_compose down -v
    ;;
  logs)
    if [[ -n "$SERVICE" ]]; then
      run_compose logs --tail=200 "$SERVICE"
    else
      run_compose logs --tail=200
    fi
    ;;
  ps)
    run_compose ps
    ;;
  config)
    run_compose config
    ;;
  health)
    run_health
    ;;
esac
