# ADR-0143: Privacy, Attestation Boundary, and Composability Stance

- Status: Accepted
- Date: 2026-03-15
- Related issue: [#279](https://github.com/Agroasys/Cotsel/issues/279)

## Context
Cotsel is a non-custodial trade-settlement protocol with off-chain services for oracle progression, reconciliation, Ricardian evidence anchoring, treasury operations, and operator control-plane workflows.

Enterprise adopters need an explicit statement of scope for three questions:

- what information belongs on-chain versus off-chain
- how Cotsel references externally issued attestations without becoming the identity system of record
- how integrations can compose with Cotsel services without bypassing settlement and audit controls

Without a written boundary, integrations can drift toward unsafe patterns such as placing raw personal or compliance data on-chain, treating Cotsel as the primary source of truth for identity, or introducing custom off-chain automation that weakens determinism and auditability.

## Decision
Cotsel will remain a settlement and evidence-traceability layer, not an identity ledger, privacy product, or general-purpose workflow engine.

This decision establishes the following posture:

- on-chain data remains limited to settlement state, participant addresses/keys, configuration required by the protocol, immutable references, and evidence hashes or identifiers that are safe to disclose
- sensitive business documents, raw personal data, compliance dossiers, and operator evidence bundles remain off-chain by default
- externally issued attestations may be referenced by hash, identifier, subject reference, status, issuer, timestamp, or expiry metadata when operationally justified, but the attestation payload itself remains off-chain unless there is a narrowly approved reason
- composability is supported through stable contracts, deterministic service boundaries, and evidence-linked integrations rather than arbitrary embedded customer logic

## On-Chain vs Off-Chain Data Boundary
### Allowed on-chain by default
- trade lifecycle state and escrow balances
- participant wallet or signing addresses already required by the protocol
- Ricardian document hashes and other immutable evidence anchors
- event references needed for reconciliation, dispute review, and deterministic replay
- bounded operational identifiers that do not expose raw personal or regulated data

### Off-chain by default
- raw PII, passports, national IDs, tax documents, bank account details, and account recovery material
- raw KYB, KYT, AML, sanctions-screening, or vendor decision payloads
- invoices, bills of lading, inspection reports, legal PDFs, and other supporting documents in their full content form
- mutable operator notes, ticket transcripts, or internal approval narratives
- vendor-specific evidence payloads that can be re-fetched or revalidated by reference

### Escalation rule
If a team believes new data must be published on-chain, the change must first document:

- why an off-chain reference is insufficient
- what privacy, regulatory, and operational impact the disclosure introduces
- what rollback or containment path exists if the disclosure proves unsafe

No such expansion is approved by this ADR.

## Attestation Boundary
Cotsel may consume or reference attestations issued by external systems, operators, or service-owned workflows, but it will not become the canonical source of truth for identity data.

Rules:

- raw PII is not stored on-chain by default
- attestation payloads remain off-chain unless a separate approved decision record states otherwise
- Cotsel stores or propagates only the minimum attestation reference surface needed for settlement, audit, or operator workflows
- attestation verification remains the responsibility of the issuing or integrating service boundary, not the core protocol contracts
- downstream operator surfaces may show status, issuer, timestamps, expiry, and evidence references, but not replicate full external dossiers by default

This keeps identity, compliance, and settlement concerns separated while preserving audit-grade linkage between them.

## Composability Stance
Cotsel is integration-friendly, but composition must preserve determinism, auditability, and clear ownership.

Supported composition patterns:

- marketplaces or ERP systems invoking Cotsel through bounded service contracts
- gateway read models that aggregate operator-facing state without mutating protocol semantics
- oracle and reconciliation workflows that attach verifiable evidence references to settlement transitions
- external compliance or attestation providers whose outputs are referenced rather than embedded wholesale

Unsupported by default:

- customer-defined scripting inside protocol-critical services
- integrations that bypass evidence or approval boundaries and write directly into privileged service paths
- use of Cotsel as a generic identity registry, privacy-preserving wallet platform, or confidential-data host

## Alternatives Considered
### A) Treat Cotsel as the enterprise system of record for identity and compliance
- Pros: fewer external dependencies for integrators.
- Cons: expands the protocol surface into high-liability data stewardship, weakens separation of concerns, and pushes privacy-sensitive data toward the wrong trust boundary.

### B) Keep all enterprise boundary questions implicit
- Pros: less documentation work up front.
- Cons: invites inconsistent integrations, makes audits harder, and increases the risk of unsafe data placement or misleading product claims.

### C) Explicit settlement-only boundary with attestation references (chosen)
- Pros: keeps the protocol focused, preserves evidence traceability, and makes integration expectations auditable.
- Cons: integrators still need external systems for identity and compliance truth.

## Risk Analysis
### Privacy and regulatory posture
- Keeping raw PII and full compliance payloads off-chain reduces irreversible disclosure risk.
- Minimal on-chain references still require review to avoid accidental leakage through identifiers.

### Operational complexity
- External attestations introduce dependency on off-chain issuers and operator workflows.
- This is acceptable because Cotsel already depends on off-chain evidence and service-owned control planes for safe operation.

### Product clarity
- The ADR reduces the risk of overclaiming by stating what Cotsel does not provide.
- Integrations remain composable, but only through bounded contracts and reviewable service paths.

## Evidence
### Canonical repository surfaces
- [README.md](../../README.md)
- [docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md](../runbooks/compliance-boundary-kyb-kyt-sanctions.md)
- [docs/runbooks/hybrid-split-walkthrough.md](../runbooks/hybrid-split-walkthrough.md)
- [docs/runbooks/dashboard-gateway-operations.md](../runbooks/dashboard-gateway-operations.md)

### Closeout expectation
- merged ADR PR linked to issue #279
- passing docs/roadmap consistency guard in CI

## Rollback
If this ADR is superseded or rejected, revert the ADR file and replace it with a new decision record that explicitly documents the revised boundary. Any implementation work that depends on this ADR must reference the superseding record before changing protocol or service behavior.
