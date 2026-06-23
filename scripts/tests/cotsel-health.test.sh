#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/cotsel.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

state_dir="$tmp_dir/state"
mkdir -p "$state_dir"

# Hermetic workdir: a copy of the compose file plus a minimal .env.runtime with
# notifications disabled, so the run does not depend on the ambient environment.
cp "$ROOT_DIR/docker-compose.services.yml" "$tmp_dir/docker-compose.services.yml"
cat > "$tmp_dir/.env.runtime" <<'ENV'
ORACLE_NOTIFICATIONS_ENABLED=false
RECONCILIATION_NOTIFICATIONS_ENABLED=false
ENV

cat > "$tmp_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${DOCKER_MOCK_STATE_DIR:?}"
log_file="${DOCKER_MOCK_LOG_FILE:?}"
printf '%s\n' "$*" >> "$log_file"

if [[ "${1:-}" == "inspect" ]]; then
  shift
  if [[ "${1:-}" == "-f" ]]; then
    format="${2:-}"
    if [[ "$format" == *".State.Status"* ]]; then
      echo "running"
      exit 0
    fi
    if [[ "$format" == *".State.Health.Status"* ]]; then
      echo "healthy"
      exit 0
    fi
    exit 0
  fi
fi

if [[ "${1:-}" != "compose" ]]; then
  echo "unexpected docker invocation: $*" >&2
  exit 1
fi

shift
profile=""
while (($#)); do
  case "$1" in
    -f)
      shift 2
      ;;
    --profile)
      profile="${2:-}"
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

command="${1:-}"
shift || true

case "$command" in
  ps)
    if [[ "${1:-}" == "-q" ]]; then
      service="${2:-}"
      # Exercise the readiness wait loop: report reconciliation as not-yet-present
      # for the first couple of polls, then healthy.
      if [[ "$service" == "reconciliation" ]]; then
        counter_file="$state_dir/reconciliation_ps_q_count"
        count=0
        if [[ -f "$counter_file" ]]; then
          count="$(cat "$counter_file")"
        fi
        count=$((count + 1))
        echo "$count" > "$counter_file"
        if (( count < 3 )); then
          exit 0
        fi
      fi
      echo "cid-${profile}-${service}"
      exit 0
    fi

    if [[ "${1:-}" == "--services" ]]; then
      printf '%s\n' postgres redis indexer-pipeline indexer-graphql oracle reconciliation ricardian treasury auth gateway
      exit 0
    fi

    if [[ -n "${1:-}" ]]; then
      echo "${profile}-${1} running healthy"
      exit 0
    fi

    echo "NAME STATUS"
    exit 0
    ;;
  exec|logs|up|down|build|config|restart)
    exit 0
    ;;
  *)
    echo "unexpected docker compose command: ${command} $*" >&2
    exit 1
    ;;
esac
EOF

cat > "$tmp_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${DOCKER_MOCK_LOG_FILE:?}"
exit 0
EOF

chmod +x "$tmp_dir/docker" "$tmp_dir/curl"

health_log="$tmp_dir/health.log"
(
  cd "$tmp_dir"
  PATH="$tmp_dir:$PATH" \
    DOCKER_SERVICES_SKIP_ENV_PRECHECK=true \
    DOCKER_MOCK_STATE_DIR="$state_dir" \
    DOCKER_MOCK_LOG_FILE="$health_log" \
    DOCKER_SERVICES_WAIT_TIMEOUT_SECONDS=5 \
    DOCKER_SERVICES_WAIT_POLL_SECONDS=0 \
    DOCKER_SERVICES_HEALTH_RETRIES=1 \
    DOCKER_SERVICES_HEALTH_RETRY_DELAY_SECONDS=0 \
    "$SCRIPT" health >/dev/null
)

reconciliation_wait_count="$(cat "$state_dir/reconciliation_ps_q_count")"
if (( reconciliation_wait_count < 3 )); then
  echo "expected health check to poll reconciliation readiness; observed polls=${reconciliation_wait_count}" >&2
  exit 1
fi

if ! grep -q "http://127.0.0.1:3600/api/dashboard-gateway/v1/healthz" "$health_log"; then
  echo "expected runtime health check to probe gateway health endpoint" >&2
  cat "$health_log" >&2
  exit 1
fi

if ! grep -q "http://127.0.0.1:3005/api/auth/v1/health" "$health_log"; then
  echo "expected runtime health check to probe auth health endpoint" >&2
  cat "$health_log" >&2
  exit 1
fi

echo "cotsel health wait/profile behavior: pass"
