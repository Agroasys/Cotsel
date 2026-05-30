# Full Protocol Deployment And Health Checks

## Purpose

Use this runbook when a Base Sepolia or production-candidate environment must be
proven from deployment truth through Cotsel backend readiness and Dash handoff
coordinates.

This does not replace the lower-level gates. It wraps them into one report so
the reviewer can see the contract, chain, service, auth, signer, treasury,
governance, compliance, and Dash handoff posture in one place.

## Inputs

- A deployed or selected `AgroasysEscrow` contract.
- Matching profile env values for:
  - `GATEWAY_ESCROW_ADDRESS`
  - `ORACLE_ESCROW_ADDRESS`
  - `RECONCILIATION_ESCROW_ADDRESS`
  - `INDEXER_CONTRACT_ADDRESS`
  - `GATEWAY_CHAIN_ID=84532`
  - `STAGING_E2E_REAL_CHAIN_ID=84532`
  - `STAGING_E2E_REAL_NETWORK_NAME=Base Sepolia`
- A deploy report under `contracts/reports/deploy/base-sepolia/`.
- A trusted dashboard session artifact when running the live Dash handoff proof.

Do not use browser or wallet-first login as proof of trusted service exchange.
The trusted-session path is separate from browser login and must remain separate
in the evidence.

## Commands

Config/report contract only:

```bash
pnpm run protocol:health -- \
  --profile staging-e2e-real \
  --mode config-only \
  --output reports/full-protocol-health/staging-e2e-real.json
```

Full local/live backend lane:

```bash
pnpm run protocol:health -- \
  --profile staging-e2e-real \
  --mode live \
  --session-file /path/to/trusted-dashboard-session.json \
  --run-validate-env \
  --run-docker-health \
  --run-staging-gate \
  --output reports/full-protocol-health/staging-e2e-real-live.json
```

## Report Contract

The JSON report includes:

- profile and mode
- chain id, runtime, network name, explorer base
- canonical escrow and USDC addresses
- deploy report path, deployment tx hash, deployment block, verification status
- required service list and package versions
- auth base URL and trusted session exchange route
- gateway `readyz`, capabilities, governance, treasury, and compliance probe URLs
- trusted session posture when a session artifact is provided
- signer bindings from the trusted session artifact
- treasury capabilities from the trusted session artifact
- Dash handoff coordinates:
  - `dashboardGatewayBaseUrl`
  - `authBaseUrl`
  - `DASHBOARD_GATEWAY_SESSION_BEARER`
  - `DASHBOARD_GATEWAY_SESSION_FILE`
  - chain id
  - escrow address
  - USDC address
- pass/fail checks
- command results for enabled lower-level gates

## Pass Criteria

For `config-only`:

- profile is `staging-e2e-real`
- chain is Base Sepolia (`84532`)
- runtime is `base-sepolia` where configured
- escrow addresses are present and consistent across gateway, oracle,
  reconciliation, and indexer
- USDC addresses are consistent and match Circle Base Sepolia USDC
- deploy report exists and matches the profile contract/chain

For `live`:

- all `config-only` checks pass
- trusted dashboard session artifact is present
- the session artifact contains bearer/session truth
- the session artifact is not marked as legacy wallet login
- enabled lower-level commands pass

## Failure Handling

If the report fails:

1. Fix env/address/deploy-report mismatches first.
2. Re-run `scripts/validate-env.sh staging-e2e-real`.
3. Re-run `scripts/docker-services.sh health staging-e2e-real`.
4. Re-run `scripts/staging-e2e-real-gate.sh`.
5. Mint a fresh trusted dashboard session and rerun the report in `live` mode.

Do not hand off to Cotsel-Dash until the report is green or the exception is
explicitly recorded in the issue thread with owner, scope, and expiry.

## Related

- `docs/runbooks/runtime-truth-deployment-guide.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/base-sepolia-gasless-settlement-proof.md`
- `docs/runbooks/auth-admin-provisioning.md`
- `docs/runbooks/dashboard-gateway-operations.md`
