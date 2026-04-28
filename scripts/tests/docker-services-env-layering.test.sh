#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/docker-services.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/.env" <<'EOF'
INDEXER_START_BLOCK=1
EOF

cat > "$tmp_dir/.env.staging-e2e-real" <<'EOF'
INDEXER_START_BLOCK=222
EOF

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

output_profile_wins="$(
  cd "$tmp_dir"
  PATH="$tmp_dir:$PATH" DOCKER_SERVICES_SKIP_ENV_PRECHECK=true "$SCRIPT" config staging-e2e-real
)"

if ! grep -q 'INDEXER_START_BLOCK: 222' <<<"$output_profile_wins"; then
  echo "expected profile env to override base .env when no external override is provided" >&2
  echo "$output_profile_wins" >&2
  exit 1
fi

output_external_wins="$(
  cd "$tmp_dir"
  PATH="$tmp_dir:$PATH" DOCKER_SERVICES_SKIP_ENV_PRECHECK=true INDEXER_START_BLOCK=333 "$SCRIPT" config staging-e2e-real
)"

if ! grep -q 'INDEXER_START_BLOCK: 333' <<<"$output_external_wins"; then
  echo "expected external environment to override profile and base env files" >&2
  echo "$output_external_wins" >&2
  exit 1
fi

echo "docker-services env layering precedence: pass"
