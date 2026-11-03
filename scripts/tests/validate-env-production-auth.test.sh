#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/validate-env.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

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

assert_rejected() {
  local expected="$1"
  if (cd "$tmp_dir" && bash "$SCRIPT" runtime >out.log 2>err.log); then
    echo "expected production-like configuration to be rejected: $expected" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$tmp_dir/err.log"; then
    echo "expected rejection was not reported: $expected" >&2
    cat "$tmp_dir/err.log" >&2
    exit 1
  fi
}

cp "$ROOT_DIR/scripts/tests/fixtures/runtime.env" "$tmp_dir/.env.runtime"
set_env_value "$tmp_dir/.env.runtime" COTSEL_ENVIRONMENT staging
assert_rejected 'NODE_ENV must be production when COTSEL_ENVIRONMENT=staging'

set_env_value "$tmp_dir/.env.runtime" NODE_ENV production
assert_rejected 'RICARDIAN_AUTH_ENABLED must be true when COTSEL_ENVIRONMENT=staging'

set_env_value "$tmp_dir/.env.runtime" RICARDIAN_AUTH_ENABLED true
assert_rejected 'TREASURY_AUTH_ENABLED must be true when COTSEL_ENVIRONMENT=staging'

set_env_value "$tmp_dir/.env.runtime" TREASURY_AUTH_ENABLED true
set_env_value "$tmp_dir/.env.runtime" GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH true
assert_rejected 'GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH must be false when COTSEL_ENVIRONMENT=staging'

set_env_value "$tmp_dir/.env.runtime" GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH false
assert_rejected 'INDEXER_EXPECTED_CONTRACT_CODEHASH is required when COTSEL_ENVIRONMENT=staging'

# Unpinned, the indexer preflight degrades to "is there any code at this
# address", so a redeploy at the same address would start cleanly.
set_env_value "$tmp_dir/.env.runtime" INDEXER_EXPECTED_CONTRACT_CODEHASH \
  0xabababababababababababababababababababababababababababababababab
assert_rejected 'INDEXER_EXPECTED_ABI_FINGERPRINT is required when COTSEL_ENVIRONMENT=staging'

set_env_value "$tmp_dir/.env.runtime" INDEXER_EXPECTED_ABI_FINGERPRINT \
  cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
assert_rejected 'INDEXER_NOTIFICATIONS_ENABLED must be true when COTSEL_ENVIRONMENT=staging'

# A poison log holds the checkpoint; without a webhook it holds silently.
set_env_value "$tmp_dir/.env.runtime" INDEXER_NOTIFICATIONS_ENABLED true
assert_rejected 'INDEXER_NOTIFICATIONS_WEBHOOK_URL is required when COTSEL_ENVIRONMENT=staging'

set_env_value "$tmp_dir/.env.runtime" INDEXER_NOTIFICATIONS_WEBHOOK_URL \
  https://alerts.example.invalid/hook
(cd "$tmp_dir" && bash "$SCRIPT" runtime >out.log 2>err.log)
grep -Fq 'env validation passed for profile: runtime' "$tmp_dir/out.log"

# Only the selected staging demo may explicitly pause indexer alerts.
set_env_value "$tmp_dir/.env.runtime" INDEXER_NOTIFICATIONS_ENABLED false
set_env_value "$tmp_dir/.env.runtime" INDEXER_NOTIFICATIONS_WEBHOOK_URL ''
set_env_value "$tmp_dir/.env.runtime" INDEXER_DEMO_ALERTS_DISABLED true
set_env_value "$tmp_dir/.env.runtime" INDEXER_CONTRACT_ADDRESS 0xE8787748547A6ce40287CDE678A58e385b65d069
set_env_value "$tmp_dir/.env.runtime" INDEXER_CHAIN_ID 84532
(cd "$tmp_dir" && bash "$SCRIPT" runtime >out.log 2>err.log)
set_env_value "$tmp_dir/.env.runtime" COTSEL_ENVIRONMENT production
assert_rejected 'Disabled demo alerts require the selected Base Sepolia staging escrow and disabled notifications'
set_env_value "$tmp_dir/.env.runtime" COTSEL_ENVIRONMENT staging
set_env_value "$tmp_dir/.env.runtime" INDEXER_CHAIN_ID 8453
assert_rejected 'Disabled demo alerts require the selected Base Sepolia staging escrow and disabled notifications'

echo 'validate-env production auth guards: pass'
