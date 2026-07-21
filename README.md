# Cotsel: Commercial Trade Settlement Layer

A programmable, non-custodial settlement and controls layer for commercial transactions.

Cotsel is a programmable settlement and controls infrastructure for commercial transactions, designed to support milestone-based escrow, conditional fund release, treasury fee accrual, governed sweeping, and audit-grade evidence across the settlement lifecycle. It provides a common execution and control layer where settlement rules, agreement references, operational approvals, and reconciliation records can be coordinated with high certainty and traceability, while preserving a non-custodial posture and avoiding direct ownership of regulated fiat execution.

Cotsel was initially developed to support the Agroasys platform, but it is open-source and integration-friendly, and is designed for reuse across marketplaces, trade platforms, and enterprise transaction workflows that require deterministic settlement controls, evidence-linked execution, and reconciliation-ready operational visibility.

## At a Glance

- **What this is:** a secure settlement layer for commercial trade, including milestone-gated escrow, conditional release, disputes, timeouts, and holds.
- **What this is not:** a custody wallet, a bank, or a full marketplace application.
- **What this enables:** transparent settlement logic, deterministic operational controls, and evidence traceability for reconciliation and dispute review.

## Status and Maturity

- **Current phase:** Post-migration Base operations and launch-governance maintenance.
- **Operational readiness criteria:** `docs/runbooks/production-readiness-checklist.md`.
- **Active chain truth:** Base is the only active v1 settlement target in this repo. Base Sepolia has verified pilot evidence, and Base mainnet go/no-go plus rollback control surfaces are installed. This repo does not, by itself, prove a completed Base mainnet launch unless a filled approval record and mainnet deployment evidence are attached.
- **Control-plane posture:** Human privileged governance uses direct-sign prepare/confirm flows; legacy human queue routes fail closed and executor-backed paths are retained only for delegated or service roles.
- **Revenue and reconciliation posture:** Treasury close, external handoff, and realization workflows are evidence-led and reconciliation-gated where documented. Cotsel records settlement and treasury-control truth, but it does not become the bank, off-ramp, or customer accounting ledger.
- **Gasless posture:** Gasless execution is optional, capacity-bounded, and routed through gateway controls. Buyer authorization, gateway submission, relayer broadcast, chain confirmation, callback delivery, and reconciliation are distinct evidence steps.

## Who Should Read Next

- **Partners and integrators:** `docs/runbooks/hybrid-split-walkthrough.md`.
- **Operators:** `docs/runbooks/monitoring-alerting-baseline.md`.
- **Audit and compliance teams:** `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`.
- **Enterprise architecture reviewers:** `docs/adr/adr-0143-privacy-attestation-composability.md`.

## Scope Boundaries

- This repository focuses on settlement protocol, operations, and evidence workflows.
- It does not replace internal ERP systems, banking rails, or external marketplace frontends.
- Enterprise data-boundary and attestation expectations are defined in `docs/adr/adr-0143-privacy-attestation-composability.md`.

Operational truth ownership is deliberately split:

- **Contract truth:** escrow state, treasury fee accrual, treasury claim execution, and emitted settlement events.
- **Gateway truth:** session authorization, operator action records, signer policy, direct-sign governance confirmation, treasury workflow capability checks, and audit lineage.
- **Treasury truth:** settlement-evidence entries, accounting periods, sweep batches, external handoff records, realization records, and close-packet projections.
- **Reconciliation truth:** tie-out status, drift classification, close blockers, and exception evidence.
- **External execution truth:** bank, fiat, or off-ramp completion evidence owned by the regulated counterparty.

Optimize for deterministic operations and auditability. If a step matters in production, it should be scriptable, tested, and documented in a runbook.

Canonical target-state architecture:
[`docs/architecture/system-architecture.md`](docs/architecture/system-architecture.md)

- `contracts`: escrow state machine and settlement logic.
- `oracle`: validated real-world milestone attestations into on-chain state transitions.
- `indexer`: indexed chain events for query and operational visibility.
- `ricardian`: contract-hash evidence workflow linking legal agreement to settlement lifecycle.
- `gateway`: operator control-plane gateway for governance and compliance workflows.
- `auth`: Cotsel session boundary for trusted upstream identity exchange, refresh, revoke, and profile resolution.
- `treasury`: append-only settlement evidence, sweep-batch, close, external handoff, and revenue-control workflows.
- `reconciliation`: read-only drift detection, reconciliation reports, and close-blocking exception evidence.
- `notifications`: shared notification routing, cooldown, and delivery helper module.

## Core Components

- **Escrow Contract (`/contracts`)**
  A settlement state machine implemented in Solidity for Base-first delivery. The contract governs milestone-gated releases, direct supplier payouts, direct buyer refunds, treasury fee accrual, pause controls, dispute paths, and deterministic settlement transitions.

- **Gateway (`/gateway`)**
  The dashboard/operator control plane. It authenticates Cotsel sessions, enforces capability and signer policy, prepares and confirms direct-sign governance actions, routes treasury workflows, assembles read models, and owns gateway-side audit lineage.

- **Auth Service (`/auth`)**
  The Cotsel session boundary. In the Agroasys-integrated production model, upstream Agroasys identity is exchanged for a Cotsel session, while refresh, revoke, profile resolution, and bearer-session authorization stay local to this service.

- **Oracle Service (`/oracle`)**
  A Node.js service that submits signed milestone attestations to the contract. Attestations are schema-validated and designed to be replay-safe and idempotent. Each attestation references external evidence identifiers, such as Bill of Lading or inspection certificate references, that support operational and audit review.

- **Ricardian Anchoring (`/ricardian`)**
  The protocol does not store contracts on-chain. Each trade is anchored by a SHA-256 hash of the signed off-chain agreement (TradeID). Evidence references and settlement actions are linked to this immutable identifier across the lifecycle.

- **Indexer (`/indexer`)**
  An indexing service that tracks settlement events to support reconciliation, operational monitoring, and audit-style reporting. It provides a normalized trade timeline, state transitions, and payout references.

- **Treasury Service (`/treasury`)**
  The settlement-evidence and revenue-controls service. It stores ledger entries, accounting periods, sweep batches, matched treasury-claim evidence, external handoff references, bank/deposit evidence, realization records, and close-packet projections.

- **Reconciliation Worker (`/reconciliation`)**
  A read-only worker and report generator that compares indexed and on-chain state, persists drift findings, classifies severity, and supplies reconciliation evidence used by operations and close workflows.

- **Notifications (`/notifications`)**
  Shared notification delivery helpers with template versioning, severity routing, cooldown, and bounded retry controls for service alerts.

- **Shared Packages (`/shared-*`)**
  Shared HTTP validation/response helpers, service-to-service authentication, Postgres/RLS helpers, CORS, and Redis-backed rate-limit primitives used across services.

## How It Works

Cotsel implements a deterministic two-stage settlement flow. This supports commercial trade patterns where certain operational costs and fees can be released earlier while preserving safety for the principal settlement amount.

Active buyer and supplier settlement paths are direct-transfer paths: supplier stage payouts and buyer refunds execute inside escrow state-transition functions and emit direct payout evidence. Treasury logistics, platform, and settlement-support fee entitlements accrue to the treasury claimable balance and are swept separately through `claimTreasury()` to the configured treasury payout receiver.

## Lifecycle

- **Lock (Encumbrance)**
  The buyer locks stablecoin funds into escrow to cover goods value plus configured fees. The contract records the Ricardian TradeID and encumbers funds into two logical buckets: `stageOneAmount` for operational and fee release, and `stageTwoAmount` for final net settlement.

- **Stage 1 Release (Operational)**
  Trigger: the oracle submits a signed attestation referencing validated shipment or milestone evidence.
  Action: escrow transfers the supplier's first principal tranche directly, accrues treasury-entitled fees to `claimableUsdc[treasuryAddress]`, and emits payout and accrual evidence for indexer, treasury, and reconciliation.

- **Stage 2 Release (Final Settlement)**
  Trigger: the oracle submits a signed attestation referencing destination inspection or final acceptance evidence.
  Action: escrow transfers the remaining supplier tranche directly, completing settlement for the supplier side while treasury sweep and revenue-close evidence continue through governed controls.

- **Treasury Sweep and Close**
  Trigger: governed treasury action and matched on-chain `TreasuryClaimed` evidence.
  Action: treasury records sweep-batch execution, external handoff, realization, and close evidence without becoming the external fiat executor or accounting ledger of record.

## Tech Stack

**Contracts and toolchain**

- Smart contracts: Solidity with a Base-first runtime target.
- Testing and fuzzing: Hardhat for integration tests; Foundry for fuzz and invariant testing where applicable.

**Services and runtime**

- Service logic: TypeScript on Node.js `>=20 <23`
- Package manager: pnpm `10.29.2`
- Infrastructure: Docker and Docker Compose
- Storage: Postgres for indexed, gateway, auth, reconciliation, and treasury operational views
- Shared runtime support: Redis-backed rate limiting and nonce storage where configured; Redis is not settlement truth

**Network and assets**

- Settlement rails: Base Sepolia for verified pilot validation; Base mainnet runtime configuration and launch controls are implemented, but live mainnet activation evidence is external unless separately recorded in-repo.
- Stablecoin rail: USDC on Base for active settlement design.
- Gas management: any sponsorship or fee abstraction is optional, buyer-bounded, and not a prerequisite for settlement safety.

**Indexing and APIs**

- Indexing: EVM-native indexing with a GraphQL API backed by Postgres.

## Job and Eventing Strategy

Cotsel uses a two-tier async strategy to separate payments-grade durability from non-critical background processing.

- Durable jobs and event routing target: SQS with DLQs for durable processing of webhooks, payouts, chain events, reconciliation, and notifications, plus EventBridge for internal event routing such as `trade.updated`, `escrow.locked`, and `docs.approved`.
- Current in-repo service state: gateway, gasless execution, governance, settlement callback, treasury, and reconciliation workflows persist operational evidence and queue-like state in Postgres-backed records where implemented.
- Non-critical async jobs: BullMQ and Redis are permitted only for best-effort background tasks such as email delivery and PDF generation.
- Redis usage boundary: Redis may be used for caching, short-lived locks, and rate-limiting tokens only. Redis is never a source of truth for settlement, reconciliation, or payments-grade workflows.

See also:
[`docs/architecture/job-and-eventing-strategy.md`](docs/architecture/job-and-eventing-strategy.md)

## Repository Structure

```bash
cotsel/
├── contracts/          # Escrow contract source, tests, and active deployment path
├── oracle/             # Milestone attestation service
├── indexer/            # Chain event indexing and query layer
├── gateway/            # Operator control-plane gateway
├── reconciliation/     # Drift detection and settlement verification
├── ricardian/          # Ricardian hash and evidence-linking service
├── treasury/           # Settlement evidence, payout eligibility, and treasury operations
├── notifications/      # Shared notification routing and delivery library
├── auth/               # Session and user-profile service
├── sdk/                # External integration SDK
├── shared/             # Shared utilities used across services
├── shared-auth/        # Shared authentication primitives and helpers
├── shared-db/          # Shared Postgres pool, role, and RLS helpers
├── shared-edge/        # Shared CORS and rate-limit primitives
├── shared-http/        # Shared HTTP response and validation helpers
├── docs/               # ADRs, runbooks, API contracts, and governance docs
├── scripts/            # CI guards, ops scripts, and verification helpers
├── env/                # Environment templates and profile inputs
├── patches/            # Package-manager patch artifacts
├── postgres/           # Database bootstrap and local operational assets
└── reports/            # Generated validation and evidence artifacts
```

## Security and Wallet Abstraction

- **Fee / Gas Abstraction**: Any sponsored-fee or gas-abstraction path is optional, tightly bounded, and never a prerequisite for settlement safety. The default path preserves explicit non-custodial signing and does not depend on a mandatory account-abstraction rollout.

- **Gasless Execution Boundary**: Gasless create-trade and user-action execution is gateway-mediated. Browser clients submit signed authorization packages to the dashboard gateway; service-auth keys, HMAC secrets, relayer custody, gas caps, queue state, and broadcast controls stay server-side.

- **Session and Service Authentication**: The `auth` service issues Cotsel sessions from trusted upstream identity. Service-to-service routes use HMAC/API-key authentication through shared primitives, with nonce replay protection where configured.

- **Direct-Sign Governance**: Human privileged governance uses prepare -> review -> sign -> confirm. The approved operator wallet signs directly, and gateway records action state, audit evidence, verification state, monitoring state, and transaction hashes.

- **Treasury Control Boundary**: Treasury operator mutations enter through gateway-owned workflow surfaces. Treasury internal endpoints are service-to-service only; treasury stores execution evidence and accounting-control truth, while gateway owns approval/signing truth and external counterparties own fiat completion truth.

- **Rate-Limit and Redis Boundary**: Auth, gateway, oracle, treasury, and shared-edge rate limiting can use Redis-backed enforcement and explicit fail-open/fail-closed policy. Redis is support infrastructure, never settlement or reconciliation truth.

- **Oracle Key Isolation**: Oracle-gated functions are restricted to an authorized attester key. The oracle service should be deployed with strict key-management controls, isolated runtime boundaries, restricted access, and least privilege. Hardened key storage such as an HSM or equivalent secure key-management service is recommended.

- **Ricardian Anchoring Integrity**: The `ricardianHash` (TradeID) is committed at trade creation and treated as immutable for that trade lifecycle. This provides a stable reference linking off-chain agreement text to on-chain settlement state and supports audit and dispute review through verifiable evidence traceability.

## Security

See `SECURITY.md` for disclosure policy.

## Partners and Contributors

We welcome partners, sponsors, and contributors who are building secure and practical trade settlement systems. Collaboration details are in `CONTRIBUTING.md`.

---

Cotsel is an open settlement layer developed by [Agroasys](https://github.com/Agroasys). [Agroasys](https://github.com/Agroasys) is the first production adopter and contributes the operational reference implementation.
