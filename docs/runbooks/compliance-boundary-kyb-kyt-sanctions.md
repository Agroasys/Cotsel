# Compliance Boundary: KYB/KYT/Sanctions

## Purpose and scope
Define the deterministic policy boundary for compliance checks that gate trade execution in Cotsel pilot operations.

This runbook formalizes issue #128 using the approved decision record in issue #200.

Scope:
- KYB (counterparty/business verification)
- KYT (transaction/flow risk screening)
- Sanctions screening
- Decision, escalation, override, and audit evidence policy

Non-goals:
- No in-repo provider integration is implemented here.
- No protocol/on-chain behavior changes are introduced by this runbook.

## Current repo boundary (ground truth)
Current architecture and runtime surface:
- The repo currently has no dedicated in-repo KYB/KYT/Sanctions provider client runtime.
- Service orchestration is service-directed (see `docs/runbooks/api-gateway-boundary.md`), and this policy defines the required gate behavior before trade execution paths proceed.
- Incident and evidence operations are executed through:
  - `docs/incidents/first-15-minutes-checklist.md`
  - `docs/runbooks/staging-e2e-real-release-gate.md`
  - `docs/observability/logging-schema.md`

Policy authority:
- Decision source: issue #200 (`Approved by: Aston (pilot default)`).
- Pilot role mapping:
  - Compliance Lead: Aston
  - Incident Commander: Aston

## Off-chain attestation reference contract
This runbook is the canonical repository source for the off-chain attestation
reference contract described by ADR-0143.

Attestation references are permitted only as minimal metadata pointers. They do
not authorize placing full provider payloads or identity dossiers inside Cotsel
logs, runbooks, or on-chain state.

Minimum attestation reference fields:
- `attestationId`: stable identifier for the attestation record in the issuing or integrating system.
- `attestationType`: category such as `kyb`, `kyt`, `sanctions_clearance`, `inspection`, or another bounded operator-approved type.
- `status`: last issuer- or integrator-reported state for the attestation reference.
- `issuer`: who issued the attestation, including stable issuer ID and issuer kind.
- `subjectRef`: stable reference to the checked subject or settlement object; this must be a pointer, not a raw dossier.
- `issuedAt`: timestamp when the attestation was issued or captured.
- `expiresAt`: optional expiry timestamp when the attestation stops being valid for fresh verification.
- `providerRef`: issuer or provider lookup reference used to re-fetch or re-verify the attestation.
- `evidenceRef`: immutable evidence bundle or document reference linked to the attestation.
- `referenceHash`: optional digest of the external attestation statement or evidence bundle when hash linkage is available.

Reference semantics:
- `issuer.id` is the stable system or operator identifier that owns the attestation decision.
- `issuer.kind` distinguishes `provider`, `service`, `operator`, or `partner` issuance paths.
- `subjectRef.reference` must remain bounded and non-sensitive; use provider-scoped IDs, document refs, or trade-linked refs instead of raw PII.
- `providerRef` is for revalidation lookup, not for displaying raw provider payloads.
- `evidenceRef` points to the supporting evidence artifact and may resolve to a ticket, document hash bundle, or operator evidence packet.
- `referenceHash` is additive and should be used when the integrator can bind the attestation to a deterministic external statement.

Contract mirror:
- OpenAPI component: `#/components/schemas/AttestationReference`
- ADR boundary: `docs/adr/adr-0143-privacy-attestation-composability.md`
- Read-only operator route: `GET /compliance/trades/{tradeId}/attestation-status`

## Attestation verification, freshness, and outage stance
Attestation references are not trusted just because they exist. They must be
evaluated against issuer trust, expiry, freshness, and current issuer
availability.

Verification rules:
- Trust only attestation issuers that are explicitly approved for the pilot or
  integration boundary. An unknown `issuer.id` or unsupported `issuer.kind`
  must be treated as untrusted.
- `providerRef` or equivalent issuer lookup evidence must exist before an
  attestation is treated as operator-usable.
- `evidenceRef` must point to the evidence artifact that justified the current
  attestation state.

Freshness rules:
- `expiresAt` is a hard stop. Once past, the attestation is `expired` and not
  sufficient for new trade-gating decisions.
- If the current operator surface cannot prove when the issuer state was last
  revalidated, the attestation must be treated as `stale`.
- Gateway query time is never an acceptable substitute for issuer verification
  time. A UI refresh does not make an attestation fresh.

Operator decision rules:

| Condition | Operator interpretation | Execution stance |
| --- | --- | --- |
| issuer trusted, not expired, latest verification available | usable | May support normal operator review and settlement gating. |
| `expiresAt` in the past | expired | Treat as deny/block until re-issued or re-verified. |
| latest verification missing or older than approved freshness window | stale | Treat as deny/block until issuer revalidation succeeds. |
| issuer unknown or not approved | untrusted | Treat as deny/block; escalate integration or policy review. |
| issuer/provider unavailable | unavailable | Treat as deny/block for new trade decisions; preserve last-known metadata only as degraded evidence. |

Outage stance:
- New trade-gating paths remain fail-closed during attestation-provider outage,
  stale verification, or unknown issuer state.
- Read-only operator surfaces may show the last known attestation reference, but
  they must mark it as degraded or unavailable and must not imply successful
  current verification.
- Emergency override follows the same approval and evidence rules as the rest of
  this compliance boundary; an outage alone does not authorize silent fail-open
  behavior.

Operator evidence minimum during attestation incidents:
- `attestationId`
- `issuer.id`
- `subjectRef.reference`
- `providerRef`
- `evidenceRef`
- last known verification timestamp, if available
- expiry timestamp, if available
- affected `tradeId` / `correlationId`
- outage start time and current degraded reason

## Decision contract (allow/deny semantics)

### Input contract for every compliance decision
Every compliance decision record must include:
- `decisionId`
- `decisionType` (`KYB` | `KYT` | `SANCTIONS`)
- `subjectId`
- `subjectType`
- `provider`
- `providerRef`
- `tradeId`
- `correlationId`
- `requestedAt`

### Result states and enforcement action
| Provider result | Boundary state | Enforcement action |
| --- | --- | --- |
| PASS | `ALLOW` | Trade may continue to normal execution path. |
| FAIL | `DENY` | Block trade execution and return deterministic compliance error code. |
| UNAVAILABLE/UNKNOWN | `DENY` (fail-closed) | Block new trade execution until provider recovery or approved emergency override. |

### Fail stance by category (pilot default)
| Category | Provider unavailable/unknown stance | Release impact |
| --- | --- | --- |
| KYB | `DENY` (fail-closed) | If outage persists, escalate per thresholds below. |
| KYT | `DENY` (fail-closed) | If outage persists, escalate per thresholds below. |
| Sanctions | `DENY` (fail-closed) | If outage persists, escalate per thresholds below. |

## Enforcement path and escalation
1. Evaluate compliance decision (`PASS`/`FAIL`/`UNAVAILABLE`) before new trade execution.
2. On `FAIL` or `UNAVAILABLE`, deny execution with canonical error code and record full audit fields.
3. Escalate provider outage duration:
   - `>30 minutes`: severity `HIGH`
   - `>2 hours`: severity `CRITICAL` and pause releases
4. During `CRITICAL`, no release promotion proceeds until provider health is restored or a documented emergency override is approved.

Routing:
- `HIGH`: Ops/Engineering on-call (chat + ticket), Incident Commander informed.
- `CRITICAL`: Platform on-call (pager) + Incident Commander.

## Provider failure behavior
Failure handling requirements:
- Retry policy must be bounded and deterministic (no unbounded retries).
- Retry only transient provider/network failures; do not retry deterministic `FAIL` outcomes.
- Each failed attempt must preserve `correlationId` and be audit logged.
- If provider health remains unavailable after bounded retries, classify as `UNAVAILABLE`, deny new trades, and escalate using the thresholds above.

## Canonical error taxonomy
Use stable error codes for operator triage and deterministic client handling:

| Error code | Meaning | Client-facing contract | Operator action |
| --- | --- | --- | --- |
| `CMP_KYB_FAILED` | KYB returned fail/deny | Trade request denied by compliance policy. | Review provider evidence and subject data; no automatic retry. |
| `CMP_KYT_FAILED` | KYT risk policy denied | Trade request denied by compliance policy. | Review risk signal and incident context. |
| `CMP_SANCTIONS_MATCH` | Sanctions screening matched prohibited entity | Trade request denied by compliance policy. | Escalate to Compliance Lead and retain evidence. |
| `CMP_PROVIDER_UNAVAILABLE` | Provider unavailable/unknown | New trades denied until provider recovery or approved override. | Trigger outage escalation and release pause rule. |
| `CMP_PROVIDER_TIMEOUT` | Provider timed out within retry budget | New trades denied under fail-closed policy. | Investigate provider/network health and retry budget telemetry. |
| `CMP_OVERRIDE_ACTIVE` | Emergency override currently active | Decision permitted only under active override window. | Verify approvals, time window, and post-incident review ticket. |
| `CMP_AUDIT_WRITE_FAILED` | Required compliance audit record could not be persisted | Treat as deny for new trades and incident condition. | Restore audit write path before resuming normal flow. |

## Audit evidence contract and retention
Minimum required audit fields:
- `decisionId`
- `decisionType`
- `subjectId`
- `subjectType`
- `provider`
- `providerRef`
- `result` (`ALLOW` | `DENY`)
- `reasonCode`
- `riskLevel`
- `tradeId`
- `correlationId`
- `requestedAt`
- `decidedAt`
- `deciderRole`
- `overrideApplied`
- `overrideApproverRoles`
- `evidenceRef`

Correlation requirements:
- Include `tradeId`, `requestId`, `txHash`, and `traceId` in logs where applicable, following `docs/observability/logging-schema.md`.

Retention:
- Compliance audit evidence retention is 7 years.
- Records must be immutable or append-only after write.

## Manual override governance (emergency only)
Override is permitted only when all conditions below are met:
1. Clear business-critical justification is documented.
2. Explicit risk acceptance is recorded.
3. Required approvals are documented:
   - Compliance Lead
   - Incident Commander
4. Maximum override window is 24 hours.

Mandatory override evidence:
- reason
- affected counterparties
- expected volume
- override start and end timestamps
- approver identities/roles
- linked post-incident review item

Pilot role mapping:
- Compliance Lead: Aston
- Incident Commander: Aston
- If one person holds both roles during pilot, the override must still be time-boxed and fully documented.

## Deterministic examples

### Example A: PASS
- Input: KYB/KYT/Sanctions checks return PASS.
- Decision: `ALLOW`.
- Action: Continue normal execution path.
- Log/audit: write full audit contract fields; include correlation fields.
- Escalation: none.

### Example B: FAIL
- Input: Sanctions screening returns match.
- Decision: `DENY` with `CMP_SANCTIONS_MATCH`.
- Action: Block trade execution.
- Log/audit: persist provider result, reason code, correlation/trade linkage, decider role.
- Escalation: notify Compliance Lead; classify incident severity based on blast radius.

### Example C: UNAVAILABLE
- Input: Provider health unavailable/unknown beyond retry budget.
- Decision: `DENY` with `CMP_PROVIDER_UNAVAILABLE`.
- Action: Block new trade execution.
- Log/audit: capture outage start time, failed attempts, correlation IDs, and affected trades.
- Escalation:
  - `>30m`: `HIGH`
  - `>2h`: `CRITICAL` + pause releases
- Recovery: resume only after provider health is restored or approved emergency override is in place.

## Operational references
- `docs/incidents/first-15-minutes-checklist.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/api-gateway-boundary.md`
- `docs/runbooks/dashboard-gateway-operations.md`
- `docs/observability/logging-schema.md`
- `docs/runbooks/production-readiness-checklist.md`
- `docs/adr/adr-0143-privacy-attestation-composability.md`
