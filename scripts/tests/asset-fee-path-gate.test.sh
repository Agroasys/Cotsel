#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/asset-fee-path-gate.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cp "$SCRIPT" "$tmp_dir/asset-fee-path-gate.sh"
mkdir -p "$tmp_dir/scripts"
cp "$ROOT_DIR/scripts/asset-fee-path-validate.mjs" "$tmp_dir/scripts/asset-fee-path-validate.mjs"

cat > "$tmp_dir/.env" <<'EOF'
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
ORACLE_RPC_URL=http://127.0.0.1:8545
RECONCILIATION_RPC_URL=http://127.0.0.1:8545
ORACLE_CHAIN_ID=31337
RECONCILIATION_CHAIN_ID=31337
EOF

cat > "$tmp_dir/.env.local" <<'EOF'
LOCAL_DEV_FEE_PATH_EXPECTED_BEHAVIOR=native-fallback
EOF

cat > "$tmp_dir/.env.staging-e2e-real" <<'EOF'
STAGING_E2E_REAL_FEE_PATH_EXPECTED_BEHAVIOR=usdc-preferred
EOF

run_in_tmp() {
  (
    cd "$tmp_dir"
    "$@"
  )
}

run_in_tmp env ASSET_FEE_PATH_ASSERT_CONFIG_ONLY=true bash ./asset-fee-path-gate.sh local-dev
if ! grep -q '"smokeCheck"' "$tmp_dir/reports/asset-fee-path/local-dev.json"; then
  echo "expected local-dev report to contain smokeCheck" >&2
  exit 1
fi

run_in_tmp env ASSET_FEE_PATH_ASSERT_CONFIG_ONLY=true bash ./asset-fee-path-gate.sh staging-e2e-real
if ! grep -q '"fallbackApplied": true' "$tmp_dir/reports/asset-fee-path/staging-e2e-real.json"; then
  echo "expected staging report to apply deterministic fallback in config-only mode" >&2
  exit 1
fi

set +e
run_in_tmp env ASSET_FEE_PATH_ASSERT_CONFIG_ONLY=true bash ./asset-fee-path-gate.sh unsupported-profile >/dev/null 2>&1
unsupported_exit=$?
set -e
if [[ "$unsupported_exit" -eq 0 ]]; then
  echo "expected unsupported profile call to fail" >&2
  exit 1
fi

echo "asset fee-path gate deterministic config behavior: pass"
