# Cotsel System Architecture

This is the canonical architecture view for the active Cotsel settlement and
control subsystem. It treats Agroasys as an upstream integration boundary rather
than duplicating the entire marketplace architecture inside Cotsel.

The diagram distinguishes implemented runtime from target or external
infrastructure. Dashed SQS and EventBridge connections are target durable
eventing; current gateway, relayer, callback, governance, treasury, and
reconciliation workflows persist operational evidence in Postgres where
implemented.

## Architecture Diagram

```mermaid
---
config:
  flowchart:
    curve: linear
  layout: elk
  theme: default
  look: handDrawn
---
flowchart TB
    classDef user fill:#E0F7FA,stroke:#006064,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef frontend fill:#E8F5E9,stroke:#2E7D32,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef identity fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef control fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef backend fill:#EDE7F6,stroke:#5E35B1,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef blockchain fill:#E3F2FD,stroke:#1565C0,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef treasury fill:#FFF9C4,stroke:#F57F17,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef storage fill:#CFD8DC,stroke:#455A64,stroke-width:2px,color:#000000,rx:5,ry:5
    classDef external fill:#FFEBEE,stroke:#C62828,stroke-width:2px,color:#000000,rx:5,ry:5

    subgraph U["Actors"]
        direction TB
        Buyer["Enterprise Buyer"]
        Supplier["Supplier / Cooperative"]
        Admin["Agroasys Admin / Operator"]
        Integrator["External Platform Integrator"]
    end
    class Buyer,Supplier,Admin user
    class Integrator external

    subgraph A["Agroasys & Client Boundary"]
        direction TB
        AgroasysApp["Agroasys Platform Web App<br/>trade approval / wallet controls / status"]
        Dash["Cotsel-Dash<br/>operator control surface"]
        AdminSigner["Privileged Admin / Hardware Wallet<br/>action-scoped governance signer"]
        Wallet["Verified Embedded Wallet<br/>EIP-712 / EIP-3009 authorization"]
        SDK["Cotsel SDK<br/>optional integration client"]
        AgroasysIdentity["Agroasys Identity Authority<br/>primary user login / role truth"]
        AgroasysBackend["Agroasys Backend<br/>settlement handoff / callbacks / fee policy"]
        ParticipantLedger[("Agroasys Participant Ledger<br/>balances / reservations / wallet history")]
        EvidenceStore[("Agroasys Document & Evidence Store<br/>documents / bounded evidence references")]
    end
    class AgroasysApp,Dash,AdminSigner,Wallet,SDK frontend
    class AgroasysIdentity identity
    class AgroasysBackend external
    class ParticipantLedger,EvidenceStore storage

    subgraph C["Cotsel Access & Control Plane"]
        direction TB
        CotselAuth["Cotsel Auth Service<br/>trusted exchange / refresh / revoke / profiles"]
        SharedAuth["shared-auth<br/>HMAC / API-key service authentication"]
        Gateway["Dashboard Gateway<br/>sessions / handoffs / callbacks / approvals / audit"]
        Relayer["Gasless Execution / Managed Relayer<br/>bounded EIP-3009 + settlement broadcast"]
        GovExecutor["Delegated Service Executor<br/>service / system roles only"]
    end
    class CotselAuth,SharedAuth identity
    class Gateway,Relayer,GovExecutor control

    subgraph S["Cotsel Settlement Services"]
        direction TB
        RicardianSvc["Ricardian Service<br/>canonical hash / document reference record"]
        OracleSvc["Oracle Service<br/>validated milestone attestations"]
        IndexerPipeline["Indexer Pipeline<br/>Base event ingestion"]
        IndexerGraphQL["Indexer GraphQL<br/>trade timeline / read models"]
        Reconciler["Reconciliation Worker<br/>read-only tie-out / drift / close blockers"]
        TreasurySvc["Treasury Service<br/>fee evidence / sweep batches / handoff / close"]
        Notifications["Shared Notifications Library<br/>routing / cooldown / bounded delivery retries"]
    end
    class RicardianSvc,OracleSvc,IndexerPipeline,IndexerGraphQL,Reconciler,Notifications backend
    class TreasurySvc treasury

    subgraph D["Cotsel Data & Eventing"]
        direction TB
        CotselDb[("Cotsel Postgres Cluster<br/>Auth / Gateway / Oracle / Ricardian / Indexer /<br/>Treasury / Reconciliation logical databases<br/>runtime + migration roles / forced RLS")]
        Redis[("Redis Support<br/>rate limits / nonces / short-lived coordination only")]
        EventBus["EventBridge<br/>target internal event routing"]
        Queue["SQS + DLQs<br/>target durable async processing"]
    end
    class CotselDb,Redis storage
    class EventBus,Queue backend

    subgraph B["Base Settlement Layer"]
        direction TB
        ChainRPC["Base RPC Providers<br/>primary + fallback"]
        EscrowSC["Agroasys Escrow Contract<br/>60 / 40 settlement / disputes / fee accrual"]
        USDC["USDC on Base"]
        NetworkStatus["Base Sepolia: verified pilot<br/>Base mainnet: approval-gated"]
    end
    class ChainRPC,EscrowSC,USDC,NetworkStatus blockchain

    subgraph E["External Evidence & Execution Boundaries"]
        direction TB
        ComplianceIssuer["Approved Compliance Attestation Issuers<br/>KYB / KYT / sanctions references"]
        LogisticsIssuer["Logistics / Inspection Evidence Issuers"]
        Bank["Bank / Fiat / Off-ramp Counterparty<br/>external completion truth"]
        Comms["Email / Chat / Webhook Destinations"]
    end
    class ComplianceIssuer,LogisticsIssuer,Bank,Comms external

    Buyer --> AgroasysApp
    Supplier --> AgroasysApp
    Admin --> Dash
    Integrator --> SDK
    AgroasysApp --> Wallet
    AgroasysApp --> AgroasysBackend
    Dash --> AgroasysIdentity
    Dash --> Gateway
    SDK -.-> Gateway

    AgroasysBackend --> AgroasysIdentity
    AgroasysBackend --> ParticipantLedger
    AgroasysBackend --> EvidenceStore
    ComplianceIssuer -.-> AgroasysBackend
    LogisticsIssuer -.-> EvidenceStore

    AgroasysBackend -->|trusted upstream session exchange| CotselAuth
    CotselAuth --> CotselDb
    CotselAuth --> Gateway
    SharedAuth -.-> CotselAuth
    SharedAuth -.-> Gateway
    SharedAuth -.-> RicardianSvc
    SharedAuth -.-> OracleSvc
    SharedAuth -.-> TreasurySvc

    AgroasysBackend -->|signed settlement handoff| Gateway
    Gateway -->|durable settlement callbacks| AgroasysBackend
    Gateway --> CotselDb
    Gateway --> IndexerGraphQL
    Gateway --> RicardianSvc
    Gateway -.-> OracleSvc
    Gateway --> TreasurySvc
    Gateway --> Reconciler
    Gateway --> GovExecutor
    Gateway --> Relayer

    Wallet -->|user-signed exact authorization| AgroasysBackend
    AgroasysBackend -->|service-auth EIP-3009 send package| Gateway
    Relayer -->|direct participant send| USDC
    Relayer -->|gasless order funding / actions| EscrowSC
    USDC -.->|direct receipt / confirmation observation| AgroasysBackend

    EscrowSC --> USDC
    EscrowSC -.-> IndexerPipeline
    IndexerPipeline -.-> ChainRPC
    IndexerPipeline --> CotselDb
    IndexerPipeline --> IndexerGraphQL
    IndexerGraphQL --> CotselDb

    RicardianSvc --> CotselDb
    OracleSvc --> CotselDb
    OracleSvc --> EscrowSC
    Reconciler --> CotselDb
    Reconciler -.-> ChainRPC
    Reconciler --> Notifications
    TreasurySvc --> CotselDb
    TreasurySvc --> Notifications
    TreasurySvc -.->|handoff and completion evidence only| Bank
    OracleSvc --> Notifications
    Notifications -.-> Comms

    GovExecutor -.->|delegated service actions only| ChainRPC
    Dash --> AdminSigner
    AdminSigner -->|human governance sign + broadcast| EscrowSC

    Redis -.-> CotselAuth
    Redis -.-> Gateway
    Redis -.-> OracleSvc
    Redis -.-> TreasurySvc

    Gateway -.-> EventBus
    OracleSvc -.-> EventBus
    TreasurySvc -.-> EventBus
    Reconciler -.-> EventBus
    EventBus -.-> Queue
    Queue -.-> Notifications

    NetworkStatus -.-> ChainRPC

    linkStyle default stroke:#9aa0a6,stroke-width:1.6px
    linkStyle 0,1,2,4,5,6,7,8,32,55 stroke:#2E7D32,stroke-width:2.2px
    linkStyle 3,12,13,23,36,51,53 stroke:#C62828,stroke-width:2.2px
    linkStyle 14,15,16,17,18,19,20,21 stroke:#EF6C00,stroke-width:2.2px
    linkStyle 22,24,25,26,27,28,29,30,31,33,40,41,42,43,44,46,48,49,50,52,57,58,59,60,61,62,63,64,65,66 stroke:#7B1FA2,stroke-width:2.2px
    linkStyle 34,35,37,38,39,45,47,54,56,67 stroke:#1565C0,stroke-width:2.8px
```

## Boundary Rules

- Agroasys owns primary identity, fee policy, participant balances, direct
  receipt discovery, send intents, reservations, wallet history, and participant
  reconciliation.
- Cotsel order escrow begins only after explicit buyer payment approval, a valid
  settlement package, successful contract lock, and reconciliation of that chain
  state back to Agroasys.
- Direct participant USDC transfers are separate from order settlement. Cotsel
  only validates and broadcasts the exact user-signed EIP-3009 authorization; it
  does not choose the participant, recipient, or amount and does not own the
  participant ledger.
- Human privileged governance uses gateway prepare, direct admin-wallet signing
  and broadcast, then gateway confirm and monitoring. The executor remains only
  for delegated service or system roles.
- Contract truth owns settlement execution and treasury fee accrual. Treasury
  owns sweep, handoff, realization, and close evidence. Gateway owns approval and
  signing truth. Reconciliation owns tie-out and exception truth. External
  regulated counterparties own fiat completion truth.
- Cotsel consumes bounded compliance and logistics attestation references. The
  repository does not contain direct KYB, KYT, sanctions, banking, or logistics
  provider execution clients.
- Redis is support infrastructure only. SQS with DLQs and EventBridge are the
  durable target; they are not represented as already replacing current
  Postgres-backed operational records.
- EIP-7702 account abstraction is parked. Active settlement and sponsored-send
  paths use EIP-712 and EIP-3009.
- Base Sepolia has verified pilot evidence. Base mainnet remains gated by the
  documented go/no-go and rollback approvals.

## Canonical Integration Sequences

### Order settlement

1. Agroasys verifies both Ricardian signatures, the accepted logistics quote,
   buyer-confirmed logistics fee, exact payment package, verified wallet link,
   policy readiness, and available participant balance.
2. The buyer selects **Pay now** and signs the backend-issued buyer and
   EIP-3009 USDC authorizations.
3. Agroasys persists the settlement intent and reservation, then submits the
   service-authenticated package to the Cotsel Gateway.
4. The managed relayer broadcasts the gasless create-trade transaction.
5. Escrow starts only when the contract lock succeeds and Agroasys reconciles
   the confirmed `TradeLocked` event. Submission or browser acknowledgement is
   not settlement truth.

### Direct participant USDC movement

- Incoming USDC is discovered and reconciled by Agroasys; Cotsel is not in the
  receipt path.
- For an outgoing direct send, Agroasys owns the intent, reservation, history,
  ledger posting, and chain reconciliation. Cotsel validates and broadcasts
  only the exact service-authenticated EIP-3009 authorization.
- Direct transfers cannot create escrow, satisfy milestones, spend escrowed
  value, or call order-release functions.

### Release and inspection

1. The verified custody/document milestone reaches Cotsel through the signed
   Agroasys handoff and Oracle boundary.
2. Stage 1 transfers the net supplier first tranche based on the 60% gross
   tranche and accrues treasury-entitled fees separately.
3. Arrival and receipt make the goods available for the order's immutable
   inspection policy; receipt alone does not accept quality.
4. Explicit inspection acceptance or expiry of the notice window without an
   open dispute authorizes the final 40% supplier release.
5. A timely dispute holds the final 40% until the governed resolution refunds
   the buyer or releases the supplier principal.
6. Indexing, signed callbacks, and reconciliation return execution truth to
   Agroasys before participant-facing order and ledger state is finalized.

### Human governance

Human privileged governance follows gateway `prepare`, admin review, direct
admin-wallet sign and broadcast, then gateway `confirm`, monitoring, and
reconciliation. The delegated executor is not a fallback for human governance;
it remains limited to intentional service or system roles.

## Runtime Components

The active runtime profile contains `auth`, `gateway`, `oracle`, `ricardian`,
`treasury`, `reconciliation`, `indexer-pipeline`, `indexer-graphql`, Postgres,
and Redis. `notifications` is a shared package embedded into service runtimes;
notification wiring is health-checked but it is not a standalone Compose
container.

## Sources of Truth

- [`../../README.md`](../../README.md)
- [`../runbooks/runtime-truth-deployment-guide.md`](../runbooks/runtime-truth-deployment-guide.md)
- [`../runbooks/runtime-stack.md`](../runbooks/runtime-stack.md)
- [`../runbooks/compliance-boundary-kyb-kyt-sanctions.md`](../runbooks/compliance-boundary-kyb-kyt-sanctions.md)
- [`../adr/adr-0411-human-governance-direct-wallet-signing.md`](../adr/adr-0411-human-governance-direct-wallet-signing.md)
- [`../adr/adr-0412-treasury-revenue-controls-boundary.md`](../adr/adr-0412-treasury-revenue-controls-boundary.md)
- [`../adr/adr-0413-agroasys-wallet-rails-and-escrow-start-boundary.md`](../adr/adr-0413-agroasys-wallet-rails-and-escrow-start-boundary.md)
- [`./job-and-eventing-strategy.md`](./job-and-eventing-strategy.md)
- [`./eip-7702-account-abstraction-deferral.md`](./eip-7702-account-abstraction-deferral.md)
