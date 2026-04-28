#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/docker-services.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "docker should not be called when env preflight fails" >&2
exit 99
EOF

chmod +x "$tmp_dir/docker"

set +e
output="$(
  cd "$tmp_dir"
  PATH="$tmp_dir:$PATH" "$SCRIPT" config local-dev 2>&1
)"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "expected docker-services config to fail when required env files are missing" >&2
  echo "$output" >&2
  exit 1
fi

if ! grep -Fq "Missing required base env file: .env" <<<"$output"; then
  echo "expected missing .env preflight error, got:" >&2
  echo "$output" >&2
  exit 1
fi

if ! grep -Fq "cp .env.example .env" <<<"$output"; then
  echo "expected missing .env error to include the exact template copy command" >&2
  echo "$output" >&2
  exit 1
fi

if grep -Fq "docker should not be called" <<<"$output"; then
  echo "docker was called despite env preflight failure" >&2
  echo "$output" >&2
  exit 1
fi

echo "docker-services env preflight: pass"
