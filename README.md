# **Agroasys: A commercial trade settlement protocol**

_**The trustless settlement engine for cross-border commodities trade.**_

The Agroasys Web3 Layer is a modular, non-custodial settlement infrastructure built on Polkadot AssetHub. It is designed to replace traditional Letters of Credit (LC) with cryptographically secured, two-stage smart contract escrows.

While built as the settlement engine for the Agroasys Platform, this protocol is open-source and agnostic, allowing any B2B marketplace to integrate trustless stablecoin settlement with Ricardian legal enforceability.

## **Architecture**

This repository houses the "Settlement Layer" of the architecture. It is designed to operate seamlessly alongside off-chain "Shadow Ledgers" or Web2 marketplaces, serving as the immutable source of truth for funds.

![web3layer](https://github.com/user-attachments/assets/c2677f8f-b430-42f6-a267-285683da74df)

### Core Components

- **Escrow Smart Contract** (`/contracts`) : A Solidity-based state machine deployed on PolkaVM. It handles the locking, dispute resolution, and atomic splitting of funds.

- **Oracle Service** (`/oracle`): A hardened Node.js service that bridges real-world logistics events (API Webhooks) to on-chain triggers, enabling automated release of funds without human intervention.

- **Ricardian Proofs**: The protocol does not store PDF data on-chain. Instead, it enforces a "Hash-First" architecture where every trade is anchored by a SHA-256 hash of the off-chain legal contract.

- **Indexer Service** (`/indexer`): A custom SubQuery/Squid instance that indexes `TradeLocked` and `FundsReleased` events to sync on-chain state with off-chain UIs or databases.

## **How It Works**

The protocol implements a deterministic Two-Stage Settlement Mechanism. This architecture allows for capital efficiency in complex transactions where operational costs, platform fees, or partial milestones must be funded before final delivery, without compromising the security of the principal amount.

### The Lifecycle

**1. Lock (Encumbrance)**

- **Action**: The Payer (Buyer/Client) deposits `USDC` (or any asset ID) into the Escrow Contract.
This includes:
  - Goods value
  - Logistics/shipping fees
  - Platform fees

- **State**: The protocol records the `ricardianHash` (Immutable Proof of Agreement) and encumbers the funds, splitting the total value into `stageOneAmount` (Operational/Fee) and `stageTwoAmount` (Net Settlement).

**2. Stage 1 Release (Intermediary / Operational)**

- **Trigger**: Oracle verifies validated documentation (e.g., Bill of Lading, Export Permit).
  
- **Action**: Actions (executed atomically in a single transaction):
  - Logistics Payment: Release the shipping fee to the TreasuryWallet to pay the logistics provider.
  - Platform Fee: Release the platform commission to the TreasuryWallet.
  - Supplier Tranche 1: Release 40% (configurable) of the goods value to the SupplierAddress (working capital coverage).

**3. Stage 2 Release (Final Settlement)**

- **Trigger**: Oracle verifies the Inspection Report (Quality/Quantity confirmation) at the destination port.

- **Action**: Release the remaining 60% of the goods value to the SupplierAddress, completing the trade.

## Tech Stack

The protocol is built on a modular stack designed for high throughput and cross-chain interoperability.

**Core Protocol & Languages**

- **Smart Contracts**: Solidity with Hardhat and Parity resolc plugin stack (`@parity/hardhat-polkadot*` + `@parity/resolc`) for PolkaVM-targeted compilation (`compile:polkavm`). Legacy `compile` remains available during migration.

- **Scripting & Logic**: TypeScript (Node.js v20.x runtime, matching CI).

- **Infrastructure**: Docker & Docker Compose (Containerization).

**Infrastructure Layers**

- **Network**: Polkadot AssetHub (System Parachain) – Utilized for low-cost, native stablecoin settlement.

- **Gas Abstraction**: Asset Conversion Pallet – Enables "Gasless" UX by allowing transaction fees to be paid in `USDC` rather than the native token (`DOT`).

- **Indexing & Querying**: SubQuery / Squid SDK (GraphQL interface over Postgres).

- **Development Framework**: Hardhat (primary testing environment) / Foundry (fuzzing).

- **Oracle Runtime**: Node.js 20.x (Isolated Environment for key management and webhook ingress).

## **Repository Structure**

```
agroasys-web3/
├── contracts/          # Solidity Smart Contracts (PolkaVM)
│   ├── AgroasysEscrow.sol
│   └── interfaces/     # IERC20 & Polkadot Precompiles
├── scripts/            # Deployment & Verification scripts
├── oracle/             # The Oracle Signing Service (Node.js)
├── indexer/            # SubQuery/Squid Indexer Schema
├── sdk/                # TypeScript SDK for Frontend Integration
└── test/               # Hardhat Unit & Integration Tests
```
## **Security & "Invisible Wallet" Features**

- **Gas Abstraction (The "Gas Station")** - This protocol utilizes the Asset Conversion Pallet. Users do not need to hold DOT to interact with the contract. The protocol automatically swaps a fraction of the deposited USDC to pay for execution gas, enabling a "Gasless" UX for enterprise clients.

- **Oracle Isolation** - The `releaseFunds` function is protected by an `onlyOracle` modifier. The Oracle Service is designed to run in a completely isolated environment (TEE or separate VPC) with restricted key access to prevent unauthorized draining of the escrow.

- **Ricardian Integrity** - The contract is agnostic to the content of the trade but strict about the Proof of Agreement. The `ricardianHash` is immutable once locked. This allows any court or auditor to mathematically verify that the funds on-chain correspond exactly to the PDF contract signed off-chain.

## **CI Parity Checks**

Run the same checks locally that GitHub Actions runs:

```bash
nvm use
# expected: Node.js v20.x
npm ci
npm run -w sdk lint
npm run -w sdk typecheck --if-present
npm run -w sdk test
npm run -w sdk build

npm run -w notifications lint
npm run -w notifications typecheck --if-present
npm run -w notifications test --if-present
npm run -w notifications build

npm run -w contracts lint
npm run -w contracts typecheck --if-present
npm run -w contracts compile
# run deterministic resolc bootstrap from docs/runbooks/polkavm-deploy-verification.md first
npm run -w contracts compile:polkavm
npm run -w contracts test
npm run -w contracts build --if-present

npm run -w oracle lint
npm run -w oracle typecheck --if-present
npm run -w oracle compile --if-present
npm run -w oracle test
npm run -w oracle build

npm run -w indexer lint
npm run -w indexer typecheck --if-present
npm run -w indexer test --if-present
npm run -w indexer build

npm run -w reconciliation lint
npm run -w reconciliation typecheck --if-present
npm run -w reconciliation test
npm run -w reconciliation build

npm run -w ricardian lint
npm run -w ricardian typecheck --if-present
npm run -w ricardian test
npm run -w ricardian build

npm run -w treasury lint
npm run -w treasury typecheck --if-present
npm run -w treasury test
npm run -w treasury build
```

> Note: `contracts` commands need a Hardhat variable for local runs:
> `HARDHAT_VAR_PRIVATE_KEY=0x0123456789012345678901234567890123456789012345678901234567890123`
>
> For deterministic PolkaVM compile, follow `docs/runbooks/polkavm-deploy-verification.md` ("Deterministic Local Bootstrap") before `compile:polkavm`.

## **Operational Runbooks**

- `docs/runbooks/reconciliation.md`
- `docs/runbooks/ricardian-hash-repro.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/emergency-disable-unpause.md`
- `docs/runbooks/notifications.md`
- `docs/runbooks/docker-profiles.md`
- `docs/runbooks/asset-conversion-fee-validation.md`
- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/api-gateway-boundary.md`
- `docs/runbooks/polkavm-deploy-verification.md`
- `docs/runbooks/hybrid-split-walkthrough.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `docs/runbooks/pull-over-push-claim-flow.md`
- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/non-custodial-pilot-user-guide.md`
- `docs/runbooks/pilot-kpi-report-template.md`
- `docs/runbooks/github-roadmap-governance.md`

## **Legal & Compliance**

- `docs/runbooks/legal-evidence-package-template.md`

## **Community Demo**

- `docs/runbooks/demo/community-demo-checklist.md`
- `docs/runbooks/demo/community-demo-script.md`


## **Contributing**

We welcome contributions from the Web3 and Trade Finance communities. Please read `CONTRIBUTING.md` for details on our code of conduct and the process for submitting pull requests.

##### Built with ❤️ for the future of Trade.

## CI Release Gate Checks

Branch protection should require these checks:

- Optional full-matrix override on PRs: add label `release-gate-full` to force all workspace jobs regardless of path filters.

- `ci/contracts`
- `ci/sdk`
- `ci/oracle`
- `ci/indexer`
- `ci/notifications`
- `ci/reconciliation`
- `ci/ricardian`
- `ci/treasury`
- `ci/release-gate`

Local parity commands:

```bash
npm ci
npm run -w contracts lint && npm run -w contracts compile && npm run -w contracts test
npm run -w sdk lint && npm run -w sdk test && npm run -w sdk build
npm run -w oracle lint && npm run -w oracle test && npm run -w oracle build
npm run -w indexer lint && npm run -w indexer build
npm run -w notifications lint && npm run -w notifications build
npm run -w reconciliation lint && npm run -w reconciliation test && npm run -w reconciliation build
npm run -w ricardian lint && npm run -w ricardian test && npm run -w ricardian build
npm run -w treasury lint && npm run -w treasury test && npm run -w treasury build
```

## Docker Profiles

Use these profile commands for deterministic runtime checks:

- `local-dev`: fast iteration profile with lightweight `indexer` responder, plus `postgres`, `redis`, `oracle`, `reconciliation`, `ricardian`, and `treasury`. `health local-dev` waits for all required services.
- `staging-e2e`: staging profile with real indexer services (`indexer-migrate`, `indexer-pipeline`, `indexer-graphql`) and all application services. `health staging-e2e` must pass before running release checks.
- `staging-e2e-real`: strict release-gate profile with dynamic start-block support, in-network GraphQL checks, warmup-aware lag verification, and reconciliation once-run validation.
- `infra`: infrastructure-only profile (`postgres`, `redis`).

```bash
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev

scripts/docker-services.sh up staging-e2e
scripts/docker-services.sh health staging-e2e

scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
```

See `docs/docker-services.md`, `docs/runbooks/staging-e2e-release-gate.md`, and `docs/runbooks/staging-e2e-real-release-gate.md` for triage and rollback instructions.
Production readiness criteria are tracked in `docs/runbooks/production-readiness-checklist.md`.

## Commit Convention

This repo follows Conventional Commits. See `CONTRIBUTING.md` for examples and PR checklist.
