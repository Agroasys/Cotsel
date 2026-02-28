# Asset Conversion Fee Validation

## Purpose

Validate fee-path behavior for escrow transaction flows with deterministic outcomes across:
- `local-dev`
- `staging-e2e-real`

The check targets:
- trade entry (`createTrade`)
- follow-up settlement transactions (stage/dispute transitions)

## Validation Model

Fee-path validation is profile-aware and policy-driven:

- `native-fallback`: expected when conversion path is unavailable (for example, local EVM profile).
- `usdc-preferred`: preferred in staging/real profile, with explicit fallback policy when live conversion evidence is not available.

Scripts:
- `scripts/asset-fee-path-gate.sh`
- `scripts/asset-fee-path-validate.mjs`

## CI Mode (Deterministic, Config-Only)

CI runs with:
- `ASSET_FEE_PATH_ASSERT_CONFIG_ONLY=true`

This mode validates:
- profile/env wiring
- expected behavior policy
- deterministic fallback decision when reference tx hashes are missing

Output:
- `reports/asset-fee-path/<profile>.json`

## Live Mode (Operator Validation)

Use live mode when you have reference tx hashes:

```bash
ASSET_FEE_PATH_ASSERT_CONFIG_ONLY=false scripts/asset-fee-path-gate.sh local-dev
ASSET_FEE_PATH_ASSERT_CONFIG_ONLY=false scripts/asset-fee-path-gate.sh staging-e2e-real
```

Set tx hash inputs in profile env:
- `*_FEE_PATH_CREATE_TX_HASH`
- `*_FEE_PATH_SETTLEMENT_TX_HASHES` (comma-separated)

Live mode evaluates each tx by comparing:
- sender native-balance delta over tx block
- expected native spend (`gasUsed * effectiveGasPrice + value`)

Classification:
- match: `native-fallback`
- mismatch: `non-native-or-unknown`

## Fallback Policy

Deterministic fallback behavior is explicit:

- `local-dev` default: `native-fallback`
- `staging-e2e-real` default: `usdc-preferred`
- `*_FEE_PATH_ALLOW_NATIVE_FALLBACK=true` allows pass with recorded fallback reason when conversion evidence is unavailable.

## Regression Tests

Run:

```bash
scripts/tests/asset-fee-path-gate.test.sh
```

This verifies deterministic config-only behavior and profile handling.

## Rollback

If this validation path needs rollback:
1. Revert the issue-#63 PR commit.
2. Re-run:

```bash
scripts/tests/asset-fee-path-gate.test.sh
npm ci
npm run -w contracts compile:polkavm
npm -w contracts test
```
