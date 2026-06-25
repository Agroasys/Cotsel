# Base Sepolia Contract Deploy And Verify

## Purpose

Deploy `AgroasysEscrow` to Base Sepolia and verify it on Basescan in the same
controlled command path.

This is a new deployment, not an upgrade. A successful run creates a new escrow
contract address. Existing trades and balances remain on the previous contract.

## Preconditions

- The deployer wallet is funded on Base Sepolia.
- `DEPLOY_ADMINS` contains at least two unique admin addresses.
- `DEPLOY_RELAYER_ADDRESS` is a service-owned gasless execution wallet.
- `DEPLOY_REQUIRED_APPROVALS` does not exceed the admin count.
- `BASESCAN_API_KEY` is available when `DEPLOY_VERIFY=true`.
- The selected oracle, treasury, relayer, and admin addresses have been reviewed for the
  rehearsal window.

## Prepare Env File

From the repository root:

```bash
cd /path/to/repo

cp env/base-sepolia-deploy.env.runtime.example env/base-sepolia-deploy.env
```

Fill `env/base-sepolia-deploy.env`.

Do not commit `env/base-sepolia-deploy.env`. Files matching `env/*.env` are
ignored by Git.

## Verify Locally Before Deploy

```bash
pnpm --filter ./contracts run compile
pnpm --filter ./contracts run test
```

If Foundry is installed:

```bash
pnpm --filter ./contracts run test:foundry
```

## Deploy And Verify

Run from the repository root:

```bash
set -a
. ./env/base-sepolia-deploy.env
set +a
pnpm --filter ./contracts run deploy:base-sepolia
```

The deploy script:

- deploys `AgroasysEscrow`
- waits for deployed bytecode to be visible
- verifies the contract when `DEPLOY_VERIFY=true`
- retries transient bytecode-indexing verification failures
- writes a deploy evidence JSON bundle

## Expected Output

Record these values from stdout:

- `Deployment tx`
- `Contract address`
- `Explorer URL`
- `Verification`
- `Evidence bundle`

The evidence bundle defaults to:

```text
reports/deploy/base-sepolia/agroasysescrow-deploy.json
```

unless `DEPLOY_EVIDENCE_OUT_DIR` is set.

## Failure Handling

If verification fails after deployment, do not rerun deployment unless a new
contract address is intended. Use the printed `Contract address` and constructor
arguments from the evidence bundle to verify manually.

If the deploy command exits before printing `Contract address`, inspect the
deployment transaction first:

```bash
cast receipt <DEPLOYMENT_TX_HASH> --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Only continue with runtime promotion after the receipt has `status: 1` and the
contract address has non-empty bytecode.

## Runtime Promotion

After a successful deploy, update the staging runtime configuration with the new
address:

```env
GATEWAY_ESCROW_ADDRESS=<new-contract-address>
ORACLE_ESCROW_ADDRESS=<new-contract-address>
RECONCILIATION_ESCROW_ADDRESS=<new-contract-address>
INDEXER_CONTRACT_ADDRESS=<new-contract-address>
INDEXER_START_BLOCK=<deployment-block-or-slightly-before>
```

Then recreate the affected services and run the relevant dashboard/operator
preflight before using the new contract in a rehearsal.
