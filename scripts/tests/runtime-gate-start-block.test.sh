#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/runtime-gate.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
workspace_dir="$tmp_dir/workspace"
bin_dir="$tmp_dir/bin"

mkdir -p "$workspace_dir/scripts" "$bin_dir"
cp "$ROOT_DIR/scripts/tests/fixtures/runtime.env" "$workspace_dir/.env.runtime"

cat > "$workspace_dir/scripts/cotsel.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "config" ]]; then
  echo "unexpected cotsel invocation: $*" >&2
  exit 1
fi

echo "INDEXER_START_BLOCK: ${INDEXER_START_BLOCK:-unset}"
EOF

cat > "$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == *"eth_blockNumber"* ]]; then
  echo '{"jsonrpc":"2.0","id":1,"result":"0x3e8"}'
  exit 0
fi

echo '{}'
EOF

chmod +x "$workspace_dir/scripts/cotsel.sh" "$bin_dir/curl"

output="$(
  cd "$workspace_dir"
  PATH="$bin_dir:$PATH" \
    STAGING_E2E_REAL_GATE_ASSERT_CONFIG_ONLY=true \
    STAGING_E2E_REAL_DYNAMIC_START_BLOCK=true \
    STAGING_E2E_REAL_START_BLOCK_BACKOFF=250 \
    STAGING_E2E_REAL_GATE_RPC_URL=http://rpc.mock \
    "$SCRIPT"
)"

if ! grep -q 'dynamic start block: INDEXER_START_BLOCK=750' <<<"$output"; then
  echo "expected dynamic start block derivation message with computed value 750" >&2
  echo "$output" >&2
  exit 1
fi

if ! grep -q 'INDEXER_START_BLOCK: 750' <<<"$output"; then
  echo "expected computed start block to be passed into cotsel config" >&2
  echo "$output" >&2
  exit 1
fi

echo "runtime gate start block propagation: pass"
