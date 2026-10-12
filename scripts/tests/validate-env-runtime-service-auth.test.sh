#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/validate-env.sh"

make_runtime_fixture() {
  local target="$1"
  cp "$ROOT_DIR/scripts/tests/fixtures/runtime.env" "$target"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
    rm -f "${file}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

session_fixture="$tmp_dir/session.env.runtime"
make_runtime_fixture "$session_fixture"
set_env_value "$session_fixture" TRUSTED_SESSION_EXCHANGE_ENABLED true
if (
  cd "$tmp_dir" &&
  cp "$session_fixture" .env.runtime &&
  bash "$SCRIPT" runtime >/tmp/validate-env-runtime-session.out 2>/tmp/validate-env-runtime-session.err
); then
  echo "expected validate-env.sh to fail when session exchange is enabled without API keys" >&2
  exit 1
fi
if ! grep -q 'TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON is required when TRUSTED_SESSION_EXCHANGE_ENABLED=true' /tmp/validate-env-runtime-session.err; then
  echo "expected trusted session exchange dependency error output" >&2
  cat /tmp/validate-env-runtime-session.err >&2
  exit 1
fi

set_env_value "$session_fixture" TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON '[{"id":"agroasys-backend","secret":"exchange-secret","active":true}]'
if (
  cd "$tmp_dir" &&
  cp "$session_fixture" .env.runtime &&
  bash "$SCRIPT" runtime >/tmp/validate-env-runtime-session.out 2>/tmp/validate-env-runtime-session.err
); then
  echo "expected validate-env.sh to fail when session exchange keys have no authority policy" >&2
  exit 1
fi
if ! grep -q 'TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON is required when TRUSTED_SESSION_EXCHANGE_ENABLED=true' /tmp/validate-env-runtime-session.err; then
  echo "expected trusted session exchange key policy error output" >&2
  cat /tmp/validate-env-runtime-session.err >&2
  exit 1
fi

settlement_fixture="$tmp_dir/settlement.env.runtime"
make_runtime_fixture "$settlement_fixture"
set_env_value "$settlement_fixture" GATEWAY_SETTLEMENT_INGRESS_ENABLED true
if (
  cd "$tmp_dir" &&
  cp "$settlement_fixture" .env.runtime &&
  bash "$SCRIPT" runtime >/tmp/validate-env-runtime-settlement.out 2>/tmp/validate-env-runtime-settlement.err
); then
  echo "expected validate-env.sh to fail when settlement ingress is enabled without service auth" >&2
  exit 1
fi
if ! grep -q 'GATEWAY_SETTLEMENT_INGRESS_ENABLED requires GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON or GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET' /tmp/validate-env-runtime-settlement.err; then
  echo "expected settlement ingress dependency error output" >&2
  cat /tmp/validate-env-runtime-settlement.err >&2
  exit 1
fi

admin_fixture="$tmp_dir/admin.env.runtime"
make_runtime_fixture "$admin_fixture"
set_env_value "$admin_fixture" AUTH_ADMIN_CONTROL_ENABLED true
if (
  cd "$tmp_dir" &&
  cp "$admin_fixture" .env.runtime &&
  bash "$SCRIPT" runtime >/tmp/validate-env-runtime-admin.out 2>/tmp/validate-env-runtime-admin.err
); then
  echo "expected validate-env.sh to fail when admin control is enabled without API key config" >&2
  exit 1
fi
if ! grep -q 'AUTH_ADMIN_CONTROL_API_KEYS_JSON is required when AUTH_ADMIN_CONTROL_ENABLED=true' /tmp/validate-env-runtime-admin.err; then
  echo "expected admin control dependency error output" >&2
  cat /tmp/validate-env-runtime-admin.err >&2
  exit 1
fi

echo "validate-env runtime service auth guards: pass"
