# **Agroasys: A commercial trade settlement protocol**

_**A non-custodial, evidence-driven settlement engine for cross-border trade workflows.**_

The Agroasys Web3 Layer is a modular, non-custodial settlement infrastructure built on Polkadot Asset Hub. It provides milestone-based smart contract escrow designed to reduce counterparty risk and shorten settlement cycles through verifiable, evidence-driven state transitions.

While initially developed as the settlement engine for the Agroasys Platform, this protocol is open-source and integration-friendly, allowing any B2B marketplace or trade workflow to adopt stablecoin escrow settlement with Ricardian contract anchoring and audit-grade evidence traceability.

## At a Glance

- What this is: a secure settlement layer for commercial trade (DvP-style escrow, milestones, dispute and timeout flows).
- What this is not: a custody wallet, a bank, or a full marketplace interface.
- What this gives partners: transparent settlement logic, deterministic operational controls, and evidence traceability for reconciliation and dispute review.

## Status and Maturity

- Current phase: Pilot.
- Operational readiness criteria: `docs/runbooks/production-readiness-checklist.md`.

## Who Should Read Next

- Partners and integrators: `docs/runbooks/hybrid-split-walkthrough.md`.
- Operators: `docs/runbooks/monitoring-alerting-baseline.md`.
- Audit and compliance teams: `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`.

## Scope Boundaries

- This repository focuses on settlement protocol, operations, and evidence workflows.
- It does not replace internal ERP systems, banking rails, or external marketplace frontends.

> Note: Optimize for deterministic operations and auditability. If a step matters in production, it should be scriptable, tested, and documented in a runbook.

## Architecture

This repository is the settlement layer in the Agroasys platform. It operates alongside off-chain systems while serving as the on-chain source of truth for settlement state.

![web3layer](https://github.com/user-attachments/assets/c2677f8f-b430-42f6-a267-285683da74df)

- `contracts`: escrow state machine and settlement logic.
- `oracle`: validated real-world milestone attestations into on-chain state transitions.
- `indexer`: indexed chain events for query and operational visibility.
- `ricardian`: contract-hash evidence workflow linking legal agreement to settlement lifecycle.
- `gateway`: operator control-plane gateway for governance and compliance workflows.

## Core Components

- **Escrow Smart Contract** (`/contracts`): A Solidity-based state machine compiled for PolkaVM using the Parity toolchain. It handles locking, dispute holds, timeouts, and deterministic splitting and routing of funds.
- **Oracle Service** (`/oracle`): A hardened Node.js service that submits signed, schema-validated milestone attestations (for example shipment and inspection evidence references) to drive state transitions.
- **Ricardian Anchoring**: The protocol does not store PDFs on-chain. Each trade is anchored by a SHA-256 hash of the off-chain legal contract (TradeID), tying evidence and settlement to a single immutable reference.
- **Indexer Service** (`/indexer`): An indexer that tracks core settlement events to support reconciliation, operational monitoring, and audit-style reporting.

## How It Works

The protocol implements a deterministic two-stage settlement mechanism. This supports flows where operational costs and fees can be released earlier, while preserving safety of the principal settlement amount.

### The Lifecycle

1. **Lock (Encumbrance)**
   **Action:** Buyer deposits `USDC` (or any configured asset) into escrow, covering goods value, logistics fees, and platform fees.  
   **State:** Protocol records `ricardianHash` and encumbers funds into `stageOneAmount` (operational and fee) and `stageTwoAmount` (net settlement).
2. **Stage 1 Release (Operational)**
   **Trigger:** Oracle submits a signed attestation referencing validated documentation (for example Bill of Lading and export permit).  
   **Action:** In one atomic transaction, logistics fee is paid to `TreasuryWallet`, platform fee is paid to `TreasuryWallet`, and supplier tranche 1 (default 40%, configurable) is paid to `SupplierAddress`.
3. **Stage 2 Release (Final Settlement)**
   **Trigger:** Oracle submits a signed attestation referencing destination inspection evidence (quality and quantity confirmation).  
   **Action:** Remaining supplier tranche (default 60%) is released to `SupplierAddress`, completing settlement.

## Tech Stack

### Core Protocol and Languages

- Smart contracts: Solidity with Hardhat and Parity resolc plugin stack (`@parity/hardhat-polkadot*` + `@parity/resolc`) for `compile:polkavm`. Legacy `compile` remains during migration.
- Scripting and service logic: TypeScript on Node.js v20.x (same baseline as CI).
- Infrastructure: Docker and Docker Compose.

### Infrastructure Layers

- Network: Polkadot Asset Hub for low-cost native stablecoin settlement rails.
- Fee payment: Asset Conversion Pallet for fee payment in `USDC` instead of `DOT` where supported.
- Indexing and querying: SubQuery or Squid + GraphQL over Postgres.
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
├── gateway/            # Dashboard operator gateway service
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
npm run -w gateway lint && npm run -w gateway test && npm run -w gateway build
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
- `ci/gateway`
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

Dashboard / Ops API:

- `docs/api/web3layer-dashboard-gateway.openapi.yml`
- `docs/runbooks/dashboard-api-gateway-boundary.md`
- `docs/runbooks/dashboard-gateway-operations.md`

Community demo:

- `docs/runbooks/demo/community-demo-checklist.md`
- `docs/runbooks/demo/community-demo-script.md`

## Contributing

See `CONTRIBUTING.md` for contribution flow and PR expectations.

## Security

See `SECURITY.md` for disclosure policy.

## Partners and Contributors

We welcome partners, sponsors, and contributors who are building secure and practical trade settlement systems. Collaboration details are in `CONTRIBUTING.md`.
