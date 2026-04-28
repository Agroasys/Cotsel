#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/docker-services.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "compose" ]]; then
  echo "unexpected docker invocation: $*" >&2
  exit 1
fi

if [[ "$*" == *" config"* ]]; then
  echo "INDEXER_START_BLOCK: ${INDEXER_START_BLOCK:-unset}"
  exit 0
fi

echo "unexpected docker compose action: $*" >&2
exit 1
EOF

chmod +x "$tmp_dir/docker"

output="$(
  cd "$ROOT_DIR"
  PATH="$tmp_dir:$PATH" DOCKER_SERVICES_SKIP_ENV_PRECHECK=true INDEXER_START_BLOCK=123 "$SCRIPT" config staging-e2e-real
)"

if ! grep -q 'INDEXER_START_BLOCK: 123' <<<"$output"; then
  echo "expected exported INDEXER_START_BLOCK to win in docker-services config output" >&2
  echo "$output" >&2
  exit 1
fi

echo "docker-services env precedence: pass"
