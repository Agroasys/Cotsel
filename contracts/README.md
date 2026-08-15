# Agroasys escrow contracts

This package contains the non-upgradeable Agroasys escrow contract, deployment tooling, and contract tests for Base.

## Settlement authority

- A buyer creates a trade through an EIP-712 authorization and a USDC transfer authorization.
- The Oracle may release stage one after the approved custody and document checks, then open the configured inspection window.
- The protected final tranche is released either through a buyer-signed inspection acceptance or after the inspection deadline. The Oracle cannot submit an early acceptance.
- Buyer dispute, timeout, and finalization authorizations are scoped to the chain, contract, trade, action, nonce, and deadline.
- Redis, the Oracle service, and off-chain projections are not financial truth. Contract state and finalized canonical events remain authoritative.

## Governance

The Base Sepolia baseline is three distinct administrators with a two-approval threshold. Governance supports administrator add, remove, and atomic replacement; threshold changes; relayer rotation; Oracle rotation; and treasury payout receiver rotation.

Every governance proposal records the current governance epoch. A successful authority change advances the epoch, so approvals collected under an old authority set cannot execute later. Governance changes use the contract timelock. Administrator removal must retain a spare administrator above the threshold.

Any administrator may pause the global protocol, claims, or one trade immediately. Recovery is quorum controlled through `proposeUnpause`, `approveUnpause`, and `cancelUnpauseProposal`. An unpause proposal must identify its scope and a non-zero incident reference. Global recovery also requires an active Oracle.

The Oracle, treasury, relayer, deployer, administrators, and any declared buyer or supplier wallets must remain separate identities. Deployment validation and contract execution both reject unsafe overlaps.

## Source layout

```text
src/AgroasysEscrow.sol                 Hardhat deployment source
foundry/src/AgroasysEscrow.sol         Foundry test mirror
scripts/deploy-base.ts                  Canonical Base deployment path
scripts/lib/baseDeploymentConfig.ts     Network and role validation
tests/                                  Hardhat unit and deployment tests
foundry/test/                            Fuzz and invariant tests
```

The Hardhat and Foundry escrow sources must be byte-for-byte identical. A test enforces this rule. Hardhat is the canonical compiler and deployment path; the repository does not use a second Ignition deployment definition.

## Local verification

From the repository root:

```bash
pnpm --dir contracts compile
pnpm --dir contracts lint
pnpm --dir contracts typecheck
pnpm --dir contracts test
pnpm --dir contracts test:foundry
```

The deployable runtime must remain below the EVM 24,576-byte limit and the repository's 24,000-byte engineering ceiling.

## Base Sepolia deployment

Set the required environment values through the protected deployment environment:

```text
BASE_SEPOLIA_RPC_URL
BASESCAN_API_KEY
DEPLOY_ORACLE_ADDRESS
DEPLOY_TREASURY_ADDRESS
DEPLOY_RELAYER_ADDRESS
DEPLOY_ADMINS
DEPLOY_REQUIRED_APPROVALS=2
DEPLOY_VERIFY=true
```

`DEPLOY_ADMINS` must contain exactly three distinct Base Sepolia administrator addresses. Run:

```bash
pnpm --dir contracts deploy:base-sepolia
```

The deployment script verifies the explorer source and constructor arguments, compares normalized local and live runtime bytecode, attests the token and all runtime roles, and writes the deployment receipt and evidence. Do not propagate an address until an independent reviewer accepts that evidence.

## Rollback

Non-upgradeable contracts cannot transfer active trades to another address. Follow [contract-cohort-rollback.md](../docs/runbooks/contract-cohort-rollback.md): stop intake, inventory and reconcile every active cohort, pin compatible consumer artifacts, and keep indexing every address with non-zero exposure.
