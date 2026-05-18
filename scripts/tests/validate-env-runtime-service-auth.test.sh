#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/validate-env.sh"

make_runtime_fixture() {
  local target="$1"
  cp "$ROOT_DIR/.env.runtime.example" "$target"
  cat >> "$target" <<'EOF'
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres-password
AUTH_DB_NAME=auth_db
GATEWAY_DB_NAME=gateway_db
RICARDIAN_DB_NAME=ricardian_db
TREASURY_DB_NAME=treasury_db
ORACLE_DB_NAME=oracle_db
RECONCILIATION_DB_NAME=reconciliation_db
INDEXER_DB_NAME=indexer_db
ORACLE_PRIVATE_KEY=0xabc123
ORACLE_RPC_URL=https://rpc.example/oracle
RECONCILIATION_RPC_URL=https://rpc.example/reconciliation
GATEWAY_RPC_URL=https://rpc.example/gateway
INDEXER_RPC_ENDPOINT=https://rpc.example/indexer
ORACLE_ESCROW_ADDRESS=0x1111111111111111111111111111111111111111
RECONCILIATION_ESCROW_ADDRESS=0x1111111111111111111111111111111111111111
GATEWAY_ESCROW_ADDRESS=0x1111111111111111111111111111111111111111
INDEXER_CONTRACT_ADDRESS=0x1111111111111111111111111111111111111111
ORACLE_USDC_ADDRESS=0x2222222222222222222222222222222222222222
RECONCILIATION_USDC_ADDRESS=0x2222222222222222222222222222222222222222
GATEWAY_USDC_ADDRESS=0x2222222222222222222222222222222222222222
TRUSTED_SESSION_EXCHANGE_ENABLED=false
AUTH_ADMIN_CONTROL_ENABLED=false
GATEWAY_SETTLEMENT_INGRESS_ENABLED=false
GATEWAY_SETTLEMENT_CALLBACK_ENABLED=false
EOF
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

session_fixture="$tmp_dir/session.env.runtime"
make_runtime_fixture "$session_fixture"
cat >> "$session_fixture" <<'EOF'
TRUSTED_SESSION_EXCHANGE_ENABLED=true
EOF
if (
  cd "$tmp_dir" &&
  cp "$session_fixture" .env.runtime &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-runtime-session.out 2>/tmp/validate-env-runtime-session.err
); then
  echo "expected validate-env.sh to fail when session exchange is enabled without API keys" >&2
  exit 1
fi
if ! grep -q 'TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON is required when TRUSTED_SESSION_EXCHANGE_ENABLED=true' /tmp/validate-env-runtime-session.err; then
  echo "expected trusted session exchange dependency error output" >&2
  cat /tmp/validate-env-runtime-session.err >&2
  exit 1
fi

settlement_fixture="$tmp_dir/settlement.env.runtime"
make_runtime_fixture "$settlement_fixture"
cat >> "$settlement_fixture" <<'EOF'
GATEWAY_SETTLEMENT_INGRESS_ENABLED=true
EOF
if (
  cd "$tmp_dir" &&
  cp "$settlement_fixture" .env.runtime &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-runtime-settlement.out 2>/tmp/validate-env-runtime-settlement.err
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
cat >> "$admin_fixture" <<'EOF'
AUTH_ADMIN_CONTROL_ENABLED=true
EOF
if (
  cd "$tmp_dir" &&
  cp "$admin_fixture" .env.runtime &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-runtime-admin.out 2>/tmp/validate-env-runtime-admin.err
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
