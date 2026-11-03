#!/usr/bin/env bash
set -euo pipefail

if [ "${DEMO_MODE:-false}" = true ]; then
  test "${GATEWAY_IMAGE_TAG:-}" = "${GITHUB_SHA:-}" && test -n "${GITHUB_SHA:-}" || {
    echo 'The demo image must be built from this exact main commit.' >&2
    exit 1
  }
  node scripts/validate-base-sepolia-staging-contract.mjs \
    --manifest integration/base-sepolia-demo-contract.json \
    --deployment contracts/reports/deploy/base-sepolia/demo-deployment.json \
    --address "$BASE_SEPOLIA_ESCROW_ADDRESS" \
    --start-block "$BASE_SEPOLIA_CONTRACT_START_BLOCK" \
    --usdc "$BASE_SEPOLIA_USDC_ADDRESS"
  node scripts/verify-base-sepolia-demo-rpc.mjs \
    integration/base-sepolia-demo-contract.json \
    contracts/reports/deploy/base-sepolia/demo-deployment.json \
    contracts/reports/deploy/base-sepolia/demo-preparation.json \
    "$BASE_SEPOLIA_ESCROW_CODEHASH" "$ESCROW_ABI_FINGERPRINT"
elif [ "${DEMO_MODE:-false}" = false ]; then
  node scripts/validate-base-sepolia-staging-contract.mjs \
    --manifest integration/base-sepolia-staging-contract.json \
    --deployment contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json \
    --address "$BASE_SEPOLIA_ESCROW_ADDRESS" \
    --start-block "$BASE_SEPOLIA_CONTRACT_START_BLOCK" \
    --usdc "$BASE_SEPOLIA_USDC_ADDRESS"
else
  echo 'COTSEL_STAGING_TEST_ONLY_DEMO must be true or false.' >&2
  exit 1
fi
