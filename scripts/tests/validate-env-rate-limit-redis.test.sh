#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/validate-env.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cp "$ROOT_DIR/.env.example" "$tmp_dir/.env"
cp "$ROOT_DIR/.env.staging-e2e-real.example" "$tmp_dir/.env.staging-e2e-real"

sed -i.bak '/^ORACLE_RATE_LIMIT_REDIS_URL=/d' "$tmp_dir/.env"
rm -f "$tmp_dir/.env.bak"

if (
  cd "$tmp_dir" &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-rate-limit.out 2>/tmp/validate-env-rate-limit.err
); then
  echo "expected validate-env.sh to fail when ORACLE_RATE_LIMIT_REDIS_URL is missing" >&2
  exit 1
fi

if ! grep -q 'ORACLE_RATE_LIMIT_REDIS_URL is required when ORACLE_RATE_LIMIT_ENABLED=true' /tmp/validate-env-rate-limit.err; then
  echo "expected missing ORACLE_RATE_LIMIT_REDIS_URL error output" >&2
  cat /tmp/validate-env-rate-limit.err >&2
  exit 1
fi

echo 'ORACLE_RATE_LIMIT_REDIS_URL=redis://redis:6379' >> "$tmp_dir/.env"

(
  cd "$tmp_dir" &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-rate-limit.out 2>/tmp/validate-env-rate-limit.err
)

if ! grep -q 'env validation passed for profile: staging-e2e-real' /tmp/validate-env-rate-limit.out; then
  echo "expected validate-env.sh to pass once ORACLE_RATE_LIMIT_REDIS_URL is restored" >&2
  cat /tmp/validate-env-rate-limit.out >&2
  cat /tmp/validate-env-rate-limit.err >&2
  exit 1
fi

echo "validate-env rate-limit redis guard: pass"
