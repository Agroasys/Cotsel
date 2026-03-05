# **Agroasys: A commercial trade settlement protocol**

_**The trustless settlement engine for cross-border commodities trade.**_

The Agroasys Web3 Layer is a modular, non-custodial settlement infrastructure built on Polkadot AssetHub. It is designed to replace traditional Letters of Credit (LC) with cryptographically secured, two-stage smart contract escrows.

While built as the settlement engine for the Agroasys Platform, this protocol is open-source and agnostic, allowing any B2B marketplace to integrate trustless stablecoin settlement with Ricardian legal enforceability.

> Founder note: Optimize for deterministic operations and auditability. If a step matters in production, it should be scriptable, tested, and documented in a runbook.

## Architecture

This repository is the settlement layer in the Agroasys platform. It operates alongside off-chain systems while serving as the on-chain source of truth for settlement state.

![web3layer](https://github.com/user-attachments/assets/c2677f8f-b430-42f6-a267-285683da74df)

- `contracts`: escrow state machine and settlement logic.
- `oracle`: validated real-world event triggers into on-chain actions.
- `indexer`: indexed chain events for query and operational visibility.
- `ricardian`: contract-hash evidence workflow linking legal agreement to settlement lifecycle.

## Core Components

- **Escrow Smart Contract** (`/contracts`): A Solidity-based state machine deployed on PolkaVM. It handles locking, dispute resolution, and atomic splitting of funds.
- **Oracle Service** (`/oracle`): A hardened Node.js service that bridges real-world logistics events (API webhooks) to on-chain triggers for automated release.
- **Ricardian Proofs**: The protocol does not store PDF data on-chain. It uses a hash-first model where each trade is anchored by a SHA-256 hash of the off-chain legal contract.
- **Indexer Service** (`/indexer`): A SubQuery/Squid indexer that tracks `TradeLocked` and `FundsReleased` events to sync on-chain state with off-chain systems.

## How It Works

The protocol uses a deterministic two-stage settlement mechanism. This supports capital-efficient flows where operational costs and platform fees are released first, while preserving security of the principal settlement amount.

### The Lifecycle

1. **Lock (Encumbrance)**
   **Action:** Buyer deposits `USDC` (or any configured asset) into escrow, covering goods value, logistics fees, and platform fees.  
   **State:** Protocol records `ricardianHash` and encumbers funds into `stageOneAmount` (operational/fee) and `stageTwoAmount` (net settlement).
2. **Stage 1 Release (Intermediary / Operational)**
   **Trigger:** Oracle verifies validated documentation (for example Bill of Lading and export permit).  
   **Action:** In one atomic transaction, logistics fee is paid to `TreasuryWallet`, platform fee is paid to `TreasuryWallet`, and supplier tranche 1 (default 40%, configurable) is paid to `SupplierAddress`.
3. **Stage 2 Release (Final Settlement)**
   **Trigger:** Oracle verifies destination inspection report (quality/quantity confirmation).  
   **Action:** Remaining supplier tranche (default 60%) is released to `SupplierAddress`, completing settlement.

## Tech Stack

### Core Protocol and Languages

- Smart contracts: Solidity with Hardhat and Parity resolc plugin stack (`@parity/hardhat-polkadot*` + `@parity/resolc`) for `compile:polkavm`. Legacy `compile` remains during migration.
- Scripting and service logic: TypeScript on Node.js v20.x (same baseline as CI).
- Infrastructure: Docker and Docker Compose.

### Infrastructure Layers

- Network: Polkadot AssetHub for low-cost native stablecoin settlement rails.
- Gas abstraction: Asset Conversion Pallet for fee payment in `USDC` instead of `DOT`.
- Indexing and querying: SubQuery/Squid + GraphQL over Postgres.
- Development framework: Hardhat (primary) and Foundry (fuzzing).
- Oracle runtime: Isolated Node.js 20.x service runtime for key management and webhook ingress.

## Repository Structure

```bash
agroasys-web3/
├── contracts/          # Solidity Smart Contracts + tests (Hardhat + Foundry)
│   ├── src/
│   ├── tests/
│   └── foundry/test/
├── oracle/             # Oracle signing and event trigger service
├── indexer/            # Indexing and GraphQL pipeline
├── sdk/                # TypeScript SDK
├── auth/               # Authentication service
├── shared-auth/        # Shared auth package
├── reconciliation/     # Reconciliation service
├── notifications/      # Notification service
├── ricardian/          # Ricardian evidence service
├── treasury/           # Treasury operations service
├── scripts/            # Ops, verification, and CI guard scripts
└── docs/               # Runbooks, governance, and operational docs
```

## Security & "Invisible Wallet" Features

- **Gas Abstraction (The "Gas Station")**: Uses Asset Conversion so users do not need to hold `DOT`; protocol can settle fees in `USDC` for a gasless enterprise UX.
- **Oracle Isolation**: `releaseFunds` is protected by `onlyOracle`. Oracle service is intended to run in an isolated environment (TEE or separate VPC) with restricted key access.
- **Ricardian Integrity**: `ricardianHash` is immutable after lock, so courts and auditors can verify on-chain settlement against the exact off-chain legal document hash.

## Local Setup (Node 20)

```bash
nvm use
# expected: Node.js v20.x
npm ci
npm run lint
npm run security:deps
```

Contracts local runs require a local dev key in `HARDHAT_VAR_PRIVATE_KEY`.
Use a throwaway local-only key and never use a funded or production private key.

## Common Commands

```bash
# Contracts
npm run -w contracts compile
npm run -w contracts compile:polkavm
npm run -w contracts test

# Service quality gates (examples)
npm run -w sdk lint && npm run -w sdk test && npm run -w sdk build
npm run -w oracle lint && npm run -w oracle test && npm run -w oracle build

# Runtime profiles
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev

scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
```

## CI and Release Gate

Branch protection should require:

- `ci/contracts`
- `ci/sdk`
- `ci/oracle`
- `ci/indexer`
- `ci/notifications`
- `ci/reconciliation`
- `ci/ricardian`
- `ci/treasury`
- `ci/release-gate`

To force full matrix jobs on a PR, add label `release-gate-full`.

## Runbooks

Core operations:

- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/docker-profiles.md`
- `docs/runbooks/staging-e2e-release-gate.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/monitoring-alerting-baseline.md`
- `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`

Protocol and service operations:

- `docs/runbooks/reconciliation.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/notifications.md`
- `docs/runbooks/ricardian-hash-repro.md`
- `docs/runbooks/polkavm-deploy-verification.md`
- `docs/runbooks/asset-conversion-fee-validation.md`
- `docs/runbooks/hybrid-split-walkthrough.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `docs/runbooks/pull-over-push-claim-flow.md`

Program and governance:

- `docs/runbooks/github-roadmap-governance.md`
- `docs/runbooks/legal-evidence-package-template.md`
- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/non-custodial-pilot-user-guide.md`
- `docs/runbooks/pilot-kpi-report-template.md`

Community demo:

- `docs/runbooks/demo/community-demo-checklist.md`
- `docs/runbooks/demo/community-demo-script.md`

## Contributing

See `CONTRIBUTING.md` for contribution flow and PR expectations.

## Security

See `SECURITY.md` for disclosure policy.
