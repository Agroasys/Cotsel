#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.services.yml"
ACTION="${1:-}"
PROFILE="${2:-}"
SERVICE="${3:-}"
HEALTH_RETRIES="${DOCKER_SERVICES_HEALTH_RETRIES:-15}"
HEALTH_RETRY_DELAY_SECONDS="${DOCKER_SERVICES_HEALTH_RETRY_DELAY_SECONDS:-2}"
WAIT_TIMEOUT_SECONDS="${DOCKER_SERVICES_WAIT_TIMEOUT_SECONDS:-120}"
WAIT_POLL_SECONDS="${DOCKER_SERVICES_WAIT_POLL_SECONDS:-2}"
HEALTH_LOG_TAIL_LINES="${DOCKER_SERVICES_HEALTH_LOG_TAIL_LINES:-80}"

usage() {
  echo "Usage: scripts/docker-services.sh <build|up|down|logs|ps|health|config> <local-dev|staging-e2e|staging-e2e-real|infra> [service]" >&2
}

if [[ -z "$ACTION" || -z "$PROFILE" ]]; then
  usage
  exit 1
fi

case "$PROFILE" in
  local-dev|staging-e2e|staging-e2e-real|infra)
    ;;
  *)
    echo "Unsupported profile: $PROFILE" >&2
    usage
    exit 1
    ;;
esac

case "$ACTION" in
  build|logs)
    ;;
  health|up|down|ps|config)
    if [[ -n "$SERVICE" ]]; then
      echo "Action '$ACTION' does not accept a service argument" >&2
      usage
      exit 1
    fi
    ;;
  *)
    ;;
esac

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
while IFS= read -r line; do
  key="${line%%=*}"
  value="${line#*=}"
  ORIGINAL_ENV_KEYS+=("$key")
  ORIGINAL_ENV_VALUES+=("$value")
done < <(env)

restore_original_environment() {
  local idx=0
  for key in "${ORIGINAL_ENV_KEYS[@]}"; do
    export "$key=${ORIGINAL_ENV_VALUES[$idx]}"
    idx=$((idx + 1))
  done
}

load_env_file ".env"
restore_original_environment
if [[ "$PROFILE" == "local-dev" ]]; then
  load_env_file ".env.local"
else
  load_env_file ".env.${PROFILE}"
fi
restore_original_environment

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
  run_compose ps --services --filter status=running | grep -qx "$service_name"
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

check_required_services() {
  local required_services=()

  case "$PROFILE" in
    local-dev)
      required_services=(postgres redis indexer oracle reconciliation ricardian treasury)
      ;;
    staging-e2e|staging-e2e-real)
      required_services=(postgres redis indexer-pipeline indexer-graphql oracle reconciliation ricardian treasury)
      ;;
    infra)
      required_services=(postgres redis)
      ;;
  esac

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

  case "$PROFILE" in
    local-dev)
      if is_running "indexer"; then
        run_compose exec -T indexer node -e "fetch('http://127.0.0.1:${graphql_port}${graphql_path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { __typename }' }) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
        return 0
      fi
      ;;
    staging-e2e|staging-e2e-real)
      if is_running "indexer-graphql"; then
        run_compose exec -T indexer-graphql node -e "fetch('http://127.0.0.1:${graphql_port}${graphql_path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { __typename }' }) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
        return 0
      fi
      ;;
  esac

  if is_running "indexer-graphql"; then
    run_compose exec -T indexer-graphql node -e "fetch('http://127.0.0.1:${graphql_port}${graphql_path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { __typename }' }) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
    return 0
  fi

  if is_running "indexer"; then
    run_compose exec -T indexer node -e "fetch('http://127.0.0.1:${graphql_port}${graphql_path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { __typename }' }) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
    return 0
  fi

  return 1
}

check_indexer_graphql() {
  local graphql_port="${INDEXER_GRAPHQL_PORT:-4350}"

  if with_retries "indexer graphql endpoint" check_indexer_graphql_once "$graphql_port"; then
    if [[ "$PROFILE" == "local-dev" ]]; then
      echo "indexer graphql endpoint: ok (indexer)"
    else
      echo "indexer graphql endpoint: ok (indexer-graphql)"
    fi
    return 0
  fi

  echo "indexer graphql endpoint check failed" >&2
  return 1
}

check_reconciliation_health_once() {
  run_compose exec -T reconciliation node reconciliation/dist/healthcheck.js >/dev/null
}

case "$ACTION" in
  build)
    if [[ -n "$SERVICE" ]]; then
      run_compose build "$SERVICE"
    else
      run_compose build
    fi
    ;;
  up)
    run_compose up -d
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
    run_compose ps
    check_required_services

    if is_running "ricardian"; then
      check_http_health "ricardian" "http://127.0.0.1:${RICARDIAN_PORT:-3100}/api/ricardian/v1/health"
    fi

    if is_running "treasury"; then
      check_http_health "treasury" "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health"
    fi

    if is_running "oracle"; then
      check_http_health "oracle" "http://127.0.0.1:${ORACLE_PORT:-3001}/api/oracle/health"
    fi

    if is_running "reconciliation"; then
      with_retries "reconciliation healthcheck" check_reconciliation_health_once
      echo "reconciliation healthcheck: ok"
    fi

    if [[ "$PROFILE" == "local-dev" || "$PROFILE" == "staging-e2e-real" ]]; then
      scripts/notifications-wiring-health.sh "$PROFILE"
    fi

    if [[ "$PROFILE" != "infra" ]]; then
      check_indexer_graphql
    else
      echo "indexer graphql endpoint: skipped for infra profile"
    fi
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    usage
    exit 1
    ;;
esac
