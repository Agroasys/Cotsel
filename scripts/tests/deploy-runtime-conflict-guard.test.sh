#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/scripts"
cp "$ROOT_DIR/scripts/deploy.sh" "$tmp_dir/scripts/deploy.sh"

cat > "$tmp_dir/scripts/validate-env.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "validate-env should not run when conflicting .env files exist" >&2
exit 99
EOF

cat > "$tmp_dir/scripts/docker-services.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "docker-services should not run when conflicting .env files exist" >&2
exit 99
EOF

cat > "$tmp_dir/scripts/staging-e2e-real-gate.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "staging gate should not run when conflicting .env files exist" >&2
exit 99
EOF

chmod +x "$tmp_dir/scripts/deploy.sh" \
  "$tmp_dir/scripts/validate-env.sh" \
  "$tmp_dir/scripts/docker-services.sh" \
  "$tmp_dir/scripts/staging-e2e-real-gate.sh"

cat > "$tmp_dir/.env.runtime" <<'EOF'
POSTGRES_USER=postgres
EOF

cat > "$tmp_dir/.env.infra" <<'EOF'
POSTGRES_USER=infra
EOF

set +e
output="$(
  cd "$tmp_dir" &&
  bash scripts/deploy.sh --skip-build 2>&1
)"
exit_code=$?
set -e

if [[ "$exit_code" -eq 0 ]]; then
  echo "expected deploy.sh to fail when a conflicting .env file exists" >&2
  exit 1
fi

if ! grep -q '.env.infra must not exist when deploying from .env.runtime' <<<"$output"; then
  echo "expected conflict guard to name the unexpected env file" >&2
  echo "$output" >&2
  exit 1
fi

if grep -q 'validate-env should not run' <<<"$output"; then
  echo "validate-env ran despite conflicting env files" >&2
  echo "$output" >&2
  exit 1
fi

echo "deploy runtime conflict guard: pass"
