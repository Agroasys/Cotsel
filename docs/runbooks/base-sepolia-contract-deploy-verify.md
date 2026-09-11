# Base Sepolia Contract Deploy And Verify

## Purpose

Prepare an exact `AgroasysEscrow` deployment request, sign it with the approved
hardware wallet, and verify the resulting Base Sepolia deployment.

This is a new deployment, not an upgrade. A successful run creates a new escrow
contract address. Existing trades and balances remain on the previous contract.

## Preconditions

- The approved hardware-controlled deployer address is funded on Base Sepolia.
- The backend bootstrap created the signer-audit role used for KMS public-key checks.
- The protected staging environment contains the managed RPC and Basescan secrets.
- Repository variables contain the independently reviewed role addresses.
- `DEPLOY_ADMINS` contains exactly three unique administrator addresses.
- `DEPLOY_RELAYER_ADDRESS` is a service-owned gasless execution wallet.
- `DEPLOY_REQUIRED_APPROVALS` is `2`.
- `BASESCAN_API_KEY` is available when `DEPLOY_VERIFY=true`.
- Oracle and relayer addresses match their dedicated KMS public keys.
- Administrator addresses belong to three independent hardware wallets.
- Treasury has an approved address but no KMS signer or signing permission.
- The deployer is a separate hardware wallet with no runtime role.
- The deployer, Oracle, treasury, relayer, and administrator addresses are all different.
- An independent reviewer approved the role inventory for the rehearsal window.
- The source commit is clean and contains all generated artifacts.

## Prepare Env File

From the repository root:

```bash
cd /path/to/repo

cp env/base-sepolia-deploy.env.runtime.example env/base-sepolia-deploy.env
```

Fill `env/base-sepolia-deploy.env`. Set `DEPLOYER_ADDRESS` to the reviewed
hardware-wallet address. Do not set `PRIVATE_KEY` or `PRIVATE_KEY2`.

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

## Protected preparation and verification

Use the `Contract Deployment Evidence` workflow for the shared Base Sepolia process.

1. Select the `main` branch.
2. Select `prepare`.
3. Enter the exact reviewed `main` commit in `commit_sha`.
4. Enter excluded buyer and supplier addresses when they are known.
5. Ask the other participant to approve the protected staging job.
6. Download and independently review the retained deployment request.
7. Sign and broadcast the exact request with the approved deployer hardware wallet.
8. Select `verify` and enter the same commit and the deployment transaction hash.
9. Ask the other participant to approve the verification job.
10. Download the retained verification evidence after the workflow succeeds.

The workflow uses these protected values:

- Secrets: `BASE_SEPOLIA_RPC_URL` and `BASESCAN_API_KEY`.
- Variables: `COTSEL_STAGING_DEPLOYER_ADDRESS`.
- Variables: `COTSEL_STAGING_ORACLE_KMS_EXPECTED_ADDRESS`.
- Variables: `COTSEL_STAGING_TREASURY_ADDRESS`.
- Variables: `COTSEL_STAGING_RELAYER_KMS_EXPECTED_ADDRESS`.
- Variables: `COTSEL_STAGING_ADMIN_1_ADDRESS` through
  `COTSEL_STAGING_ADMIN_3_ADDRESS`.

The workflow rejects a non-`main` ref or commit mismatch. It verifies that the Oracle and
relayer addresses match their KMS public keys. The workflow cannot sign or broadcast the
deployment transaction.

## Hardware-wallet signing

The preparation artifact contains the full contract-creation data and expected signer.
Review its commit, chain, nonce, predicted address, constructor roles, data hash, and gas
limit before signing. Do not copy a seed phrase or private key into a shell, environment,
CI secret, browser, or chat.

The approved custodian can use a compatible Ledger, Trezor, or browser-wallet flow. For
example, Foundry can send the exact prepared data through an attached hardware wallet:

```bash
cast send --ledger --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --from "$DEPLOYER_ADDRESS" \
  --create "$(jq -r '.transaction.data' contracts/reports/deploy/base-sepolia/agroasysescrow-deployment-request.json)"
```

Confirm the device displays the approved network and deployer account. Record the returned
transaction hash. Do not continue if the pending nonce or predicted contract address changed;
prepare and review a new request.

## Local verification

Run from the repository root:

```bash
set -a
. ./env/base-sepolia-deploy.env
set +a
pnpm --filter ./contracts run prepare:base-sepolia

export DEPLOY_TRANSACTION_HASH=<reviewed-hardware-wallet-transaction-hash>
pnpm --filter ./contracts run finalize:base-sepolia
```

The finalization script:

- requires an existing contract-creation transaction from `DEPLOYER_ADDRESS`
- compares the transaction data with the reviewed constructor request
- reads the deployment receipt and aborts unless its status is `1`
- waits for deployed bytecode to be visible
- verifies the contract when `DEPLOY_VERIFY=true`
- retries transient bytecode-indexing verification failures
- rejects a dirty or unidentified Git worktree
- records compiler settings, source hashes, artifact hashes, and live role attestation
- writes a deploy evidence JSON bundle

The source check excludes generated JSON files under
`contracts/reports/deploy/`. This exclusion lets an operator run the deploy
command again after it writes evidence. The check still rejects all other
tracked or untracked changes. Do not place source files in the deploy-report
directory.

## Expected Output

Record these values from stdout:

- `Deployment tx`
- `Contract address`
- `Deployment block`
- `Explorer URL`
- `Verification`
- `Evidence bundle`

The evidence bundle defaults to:

```text
contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json
```

unless `DEPLOY_EVIDENCE_OUT_DIR` is set. The default is anchored to the
`contracts` workspace and is identical whether the command is launched from
the repository root or from inside `contracts`.

Use the default directory for repository evidence. If a custom output directory
is inside the repository but outside `contracts/reports/deploy/`, the next
deploy rejects that uncommitted file. Use a directory outside the repository
when you need a custom location.

The bundle records the deployment block and the receipt status as
`contract.deploymentBlock` and `contract.deploymentReceiptStatus`. Both are read
from the deployment receipt, never entered by hand. `contract.deploymentBlock` is
the start block for `INDEXER_START_BLOCK` and for the `contract.deploymentBlock`
field of a candidate manifest (`integration/candidate-manifest.schema.json`); a
bundle without it cannot evidence a candidate.

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
