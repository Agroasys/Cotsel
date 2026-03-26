# Cotsel: Commercial Trade Settlement Layer
A non-custodial, evidence-driven settlement layer for cross-border trade workflows.

Cotsel is a modular settlement infrastructure built on Polkadot Asset Hub. It implements milestone-gated escrow and conditional release, designed to reduce counterparty risk and improve settlement determinism through verifiable, evidence-linked state transitions.

Cotsel was initially developed to support the Agroasys platform, but it is open-source and integration-friendly. It is designed for reuse by B2B marketplaces and trade workflows that require stablecoin escrow settlement, Ricardian agreement anchoring, and audit-grade traceability without introducing a custodial operator.

## At a Glance

- **What this is:** a secure settlement layer for commercial trade (DvP-style escrow, milestone gating, disputes, timeouts, and holds).
- **What this is not:** a custody wallet, a bank, or a full marketplace application.
- **What this enables:** transparent settlement logic, deterministic operational controls, and evidence traceability for reconciliation and dispute review.

## Status and Maturity

- **Current phase:** Pilot readiness (active development).
- **Operational readiness criteria:** `docs/runbooks/production-readiness-checklist.md`.

## Who Should Read Next

- **Partners and integrators:** `docs/runbooks/hybrid-split-walkthrough.md`.
- **Operators:** `docs/runbooks/monitoring-alerting-baseline.md`.
- **Audit and compliance teams:** `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`.
- **Enterprise architecture reviewers:** `docs/adr/adr-0143-privacy-attestation-composability.md`.

## Scope Boundaries

- This repository focuses on settlement protocol, operations, and evidence workflows.
- It does not replace internal ERP systems, banking rails, or external marketplace frontends.
- Enterprise data-boundary and attestation expectations are defined in `docs/adr/adr-0143-privacy-attestation-composability.md`.

> Note: Optimize for deterministic operations and auditability. If a step matters in production, it should be scriptable, tested, and documented in a runbook.

## Architecture

This repository is the settlement layer in the Agroasys platform. It operates alongside off-chain systems while serving as the on-chain source of truth for settlement state.

![cotsel](https://github.com/user-attachments/assets/c2677f8f-b430-42f6-a267-285683da74df)

- `contracts`: escrow state machine and settlement logic.
- `oracle`: validated real-world milestone attestations into on-chain state transitions.
- `indexer`: indexed chain events for query and operational visibility.
- `ricardian`: contract-hash evidence workflow linking legal agreement to settlement lifecycle.
- `gateway`: operator control-plane gateway for governance and compliance workflows.

## Core Components

- **Escrow Contract (`/contracts`)**  
A settlement state machine implemented in Solidity and compiled for PolkaVM using the Parity toolchain. It manages escrow locking, timeouts, dispute holds, and deterministic allocation and routing of funds based on trade state.

- **Oracle Service (`/oracle`)**  
A Node.js service that submits signed milestone attestations to the contract. Attestations are schema-validated and designed to be replay-safe and idempotent. Each attestation references external evidence identifiers (for example Bill of Lading, inspection certificate references) that support operational and audit review.

- **Ricardian Anchoring (`/ricardian`)**  
The protocol does not store contracts on-chain. Each trade is anchored by a SHA-256 hash of the signed off-chain agreement (TradeID). Evidence references and settlement actions are linked to this immutable identifier across the lifecycle.

- **Indexer (`/indexer`)**  
An indexing service that tracks settlement events to support reconciliation, operational monitoring, and audit-style reporting. It provides a normalized trade timeline, state transitions, and payout references.

## How It Works

Cotsel implements a deterministic two-stage settlement flow. This supports commercial trade patterns where certain operational costs and fees can be released earlier while preserving safety for the principal settlement amount.

## Lifecycle

- **Lock (Encumbrance)**
The buyer locks stablecoin funds into escrow to cover goods value plus configured fees. The contract records the Ricardian TradeID and encumbers funds into two logical buckets: `stageOneAmount` (operational and fee tranche) and `stageTwoAmount` (net settlement tranche).

- **Stage 1 Release (Operational)**  
Trigger: the oracle submits a signed attestation referencing validated documentation (for example shipment evidence such as Bill of Lading reference).  
Action: in a single state transition, configured fees are allocated to their recipients and the supplier receives tranche one of the principal (default 40%, configurable).

- **Stage 2 Release (Final Settlement)**  
Trigger: the oracle submits a signed attestation referencing destination inspection evidence (quality and quantity confirmation, where applicable).  
Action: the remaining supplier tranche (default 60%) is released, completing settlement.

## Tech Stack

**Contracts and toolchain**  
- Smart contracts: Solidity, compiled for PolkaVM using the Parity toolchain (`@parity/resolc` and Hardhat integration) with `compile:polkavm` as the intended release artifact.  
- Testing and fuzzing: Hardhat for integration tests; Foundry for fuzz and invariant testing where applicable.

**Services and runtime**  
- Service logic: TypeScript on Node.js 20.x  
- Infrastructure: Docker and Docker Compose  
- Storage: Postgres for indexed and operational views

**Network and assets**  
- Settlement rails: Polkadot Asset Hub (pilot on Paseo) for stablecoin settlement flows.  
- Fee payment: where supported, fee payment in USDC can be used to reduce DOT dependency.

**Indexing and APIs**  
- Indexing: SubQuery or Subsquid with a GraphQL API backed by Postgres.

## Job and Eventing Strategy

Cotsel uses a two-tier async strategy to separate payments-grade durability from
non-critical background processing.

- Durable jobs and event routing: SQS with DLQs for durable processing
  (webhooks, payouts, chain events, reconciliation, notifications) and
  EventBridge for internal event routing (`trade.updated`, `escrow.locked`,
  `docs.approved`).
- Non-critical async jobs: BullMQ (Redis) is permitted only for best-effort
  background tasks such as email sending and PDF generation.
- Redis usage boundary: Redis may be used for caching, short-lived locks, and
  rate limiting tokens only. Redis is never a source of truth for settlement,
  reconciliation, or payments-grade workflows.

See also:
[`docs/architecture/job-and-eventing-strategy.md`](docs/architecture/job-and-eventing-strategy.md)

## Repository Structure

```bash
cotsel/
├── contracts/          # Escrow contract source, tests, and PolkaVM build path
├── oracle/             # Milestone attestation service
├── indexer/            # Chain event indexing and query layer
├── gateway/            # Operator control-plane gateway
├── reconciliation/     # Drift detection and settlement verification
├── ricardian/          # Ricardian hash and evidence-linking service
├── treasury/           # Treasury ledger and payout operations
├── notifications/      # Operational notification service
├── auth/               # Session and user-profile service
├── sdk/                # External integration SDK
├── shared/             # Shared utilities used across services
├── shared-auth/        # Shared authentication primitives and helpers
├── docs/               # ADRs, runbooks, API contracts, and governance docs
├── scripts/            # CI guards, ops scripts, and verification helpers
├── env/                # Environment templates and profile inputs
├── postgres/           # Database bootstrap and local operational assets
└── reports/            # Generated validation and evidence artifacts
```

## Security and Wallet Abstraction

- **Fee Abstraction (Sponsored Fees)**: Where supported, the system can abstract network fee management from end users. This reduces the requirement for users to hold DOT directly and supports an enterprise-friendly checkout flow. Fee payment via Asset Conversion may be used depending on network support and operational configuration.

- **Oracle Key Isolation**: Oracle-gated functions are restricted to an authorized attester key (for example `onlyOracle`). The oracle service should be deployed with strict key management controls (isolated runtime, restricted access, least privilege), and may be backed by hardened key storage such as an HSM or equivalent secure key management service.

- **Ricardian Anchoring Integrity**: The `ricardianHash` (TradeID) is committed at trade creation and treated as immutable for that trade lifecycle. This provides a stable reference linking off-chain agreement text to on-chain settlement state and supports audit and dispute review through verifiable evidence traceability.

## Security

See `SECURITY.md` for disclosure policy.

Cotsel is an open settlement layer developed by [Agroasys](https://github.com/Agroasys); [Agroasys](https://github.com/Agroasys) is the first production adopter and contributes the operational reference implementation.

## Partners and Contributors

We welcome partners, sponsors, and contributors who are building secure and practical trade settlement systems. Collaboration details are in `CONTRIBUTING.md`.
