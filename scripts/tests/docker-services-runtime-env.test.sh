#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/docker-services.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/.env.runtime" <<'EOF'
INDEXER_START_BLOCK=444
POSTGRES_USER=postgres
POSTGRES_PASSWORD=secret
AUTH_DB_NAME=auth
GATEWAY_DB_NAME=gateway
RICARDIAN_DB_NAME=ricardian
TREASURY_DB_NAME=treasury
ORACLE_DB_NAME=oracle
RECONCILIATION_DB_NAME=reconciliation
INDEXER_DB_NAME=indexer
AUTH_PORT=3005
AUTH_SESSION_TTL_SECONDS=3600
RICARDIAN_PORT=3100
TREASURY_PORT=3200
ORACLE_PORT=3001
ORACLE_API_KEY=key
ORACLE_HMAC_SECRET=secret
ORACLE_PRIVATE_KEY=0xabc123
ORACLE_SETTLEMENT_RUNTIME=base-sepolia
ORACLE_CHAIN_ID=84532
ORACLE_ESCROW_ADDRESS=0x1111111111111111111111111111111111111111
ORACLE_USDC_ADDRESS=0x2222222222222222222222222222222222222222
ORACLE_INDEXER_GRAPHQL_URL=http://indexer-graphql:4350/graphql
ORACLE_RETRY_ATTEMPTS=3
ORACLE_RETRY_DELAY=1000
RECONCILIATION_SETTLEMENT_RUNTIME=base-sepolia
RECONCILIATION_CHAIN_ID=84532
RECONCILIATION_ESCROW_ADDRESS=0x1111111111111111111111111111111111111111
RECONCILIATION_USDC_ADDRESS=0x2222222222222222222222222222222222222222
RECONCILIATION_INDEXER_GRAPHQL_URL=http://indexer-graphql:4350/graphql
TREASURY_INDEXER_GRAPHQL_URL=http://indexer-graphql:4350/graphql
ORACLE_NOTIFICATIONS_ENABLED=false
ORACLE_NOTIFICATIONS_COOLDOWN_MS=300000
ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
RECONCILIATION_NOTIFICATIONS_ENABLED=false
RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS=300000
RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
GATEWAY_AUTH_BASE_URL=http://auth:3005
GATEWAY_INDEXER_GRAPHQL_URL=http://indexer-graphql:4350/graphql
GATEWAY_SETTLEMENT_RUNTIME=base-sepolia
GATEWAY_ESCROW_ADDRESS=0x1111111111111111111111111111111111111111
STAGING_E2E_REAL_NETWORK_NAME=Base\ Sepolia
STAGING_E2E_REAL_CHAIN_ID=84532
INDEXER_RPC_ENDPOINT=https://rpc.example/indexer
INDEXER_RATE_LIMIT=10
FINALITY_CONFIRMATION_BLOCKS=1
INDEXER_GRAPHQL_PORT=4350
INDEXER_CONTRACT_ADDRESS=0x1111111111111111111111111111111111111111
AUTH_RATE_LIMIT_ENABLED=false
RICARDIAN_RATE_LIMIT_ENABLED=false
TREASURY_RATE_LIMIT_ENABLED=false
ORACLE_RATE_LIMIT_ENABLED=false
GATEWAY_RATE_LIMIT_ENABLED=false
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

output_runtime="$(
  cd "$tmp_dir"
  PATH="$tmp_dir:$PATH" "$SCRIPT" config staging-e2e-real
)"

if ! grep -q 'INDEXER_START_BLOCK: 444' <<<"$output_runtime"; then
  echo "expected .env.runtime to drive docker-services config output" >&2
  echo "$output_runtime" >&2
  exit 1
fi

output_external="$(
  cd "$tmp_dir"
  PATH="$tmp_dir:$PATH" INDEXER_START_BLOCK=555 "$SCRIPT" config staging-e2e-real
)"

if ! grep -q 'INDEXER_START_BLOCK: 555' <<<"$output_external"; then
  echo "expected exported env to override .env.runtime in docker-services config output" >&2
  echo "$output_external" >&2
  exit 1
fi

echo "docker-services runtime env precedence: pass"
