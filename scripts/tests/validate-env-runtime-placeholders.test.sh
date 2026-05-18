#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/validate-env.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/.env.runtime" <<'EOF'
TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON='[{"id":"<id>","secret":"real-secret","active":true}]'
EOF

if (
  cd "$tmp_dir" &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-runtime-placeholders.out 2>/tmp/validate-env-runtime-placeholders.err
); then
  echo "expected validate-env.sh to fail when .env.runtime contains placeholder markers" >&2
  exit 1
fi

if ! grep -q '.env.runtime contains placeholder markers like <id> or <secret>' /tmp/validate-env-runtime-placeholders.err; then
  echo "expected placeholder marker error output" >&2
  cat /tmp/validate-env-runtime-placeholders.err >&2
  exit 1
fi

echo "validate-env runtime placeholder guard: pass"
