# Programmability Governance Runbook

## Purpose and scope
Define the governance boundary for Web2-triggered automation that can influence Cotsel settlement-adjacent behavior.

This runbook exists to keep automation explicit, reviewable, and reversible. It is not a license for arbitrary business logic execution. Cotsel remains a trade-settlement protocol with operator-controlled off-chain services, not a general-purpose workflow engine.

Scope:
- operator-approved automation that interacts with existing oracle, reconciliation, treasury, and gateway control surfaces
- change-control expectations for enabling, disabling, or materially changing automation behavior
- kill-switch, rollback, and incident-evidence expectations when automation risk is suspected

## Non-goals
- no smart contract, ABI, escrow-economics, or payout-semantics changes
- no arbitrary customer-defined scripting inside Cotsel services
- no deployment of new automation classes without explicit approval and recorded evidence
- no replacement of existing service-owned validation, idempotency, or replay-protection controls

## Allowed automation classes
Only the following automation categories are in scope for current Cotsel operations:

1. Oracle progression automation
   - bounded trigger execution through the existing oracle service
   - manual approval mode, redrive, and retry controls already defined by the oracle runtime and runbooks
2. Reconciliation automation
   - scheduled or operator-invoked reconciliation runs
   - deterministic report generation and drift classification
3. Treasury bridge and payout-support automation
   - destination-locked treasury sweep support
   - treasury ledger progression and payout preparation steps that remain subject to operator approval
4. Gateway control-plane automation
   - queued governance actions
   - read-model aggregation and operator-facing health/reporting surfaces

Out of scope by default:
- arbitrary customer or partner automation logic
- custom settlement branching added outside the current protocol and service boundaries
- direct execution of ad hoc scripts against production services without approved operator tooling

## Approval authority and change control
Every automation change must answer three questions before it is enabled:
- what service boundary changes?
- what failure mode is introduced or expanded?
- what rollback path returns the system to a safe known state?

Required approval path:
- service owner for the affected runtime
- ops/platform owner for operational readiness and rollback
- security review when the change affects auth, replay protection, secret handling, or privilege boundaries

Minimum change record:
- automation class affected
- reason for change
- impacted services and runbooks
- rollout environment
- rollback command or procedure
- incident owner and approval timestamp

Change-control rules:
- production enablement must happen through versioned config or reviewed code changes
- emergency enablement must be time-bounded and recorded in the incident log
- automation changes must preserve existing service-owned idempotency and replay controls

## Kill-switch and rollback strategy
If automation correctness is in doubt, default to containment before throughput.

Primary containment controls:
- global protocol pause through the approved governance path
- claims pause when claim-path risk exists independently of protocol mutation risk
- manual approval mode and redrive restraint for oracle-triggered progression
- stop or defer reconciliation scheduling when a truth-source conflict is unresolved
- disable gateway mutations when operator control-plane behavior is suspect

Rollback expectations:
- every automation-bearing change must name the safe fallback mode
- the fallback mode must avoid duplicating settlement-affecting actions
- rollback steps must reference the owning runbook and required evidence bundle

Incident rule:
- if an operator cannot explain the current automation state with request IDs, actor identity, and service logs, the system is not safe to continue in automatic mode

## Evidence and audit minimums
Every automation-affecting change or incident must preserve enough evidence to answer:
- who approved it?
- what intent was authorized?
- what system acted?
- what outcome occurred?
- how can the action be correlated to on-chain or service truth?

Minimum evidence set:
- request ID and correlation ID
- actor identity and role
- affected service/runtime
- trade ID or action key where applicable
- transaction hash or extrinsic reference where applicable
- linked incident or ticket reference
- rollback decision and timestamp when containment is used

Evidence sources:
- `docs/observability/logging-schema.md`
- `docs/incidents/first-15-minutes-checklist.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `docs/runbooks/dashboard-gateway-operations.md`

## Service-specific operational references
- Oracle progression and manual approval:
  - `docs/runbooks/oracle-redrive.md`
- Reconciliation operation and drift handling:
  - `docs/runbooks/reconciliation.md`
- Treasury payout and destination-locked sweep operations:
  - `docs/runbooks/treasury-to-fiat-sop.md`
- Emergency containment and recovery:
  - `docs/runbooks/emergency-disable-unpause.md`
- Dashboard gateway control-plane operations:
  - `docs/runbooks/dashboard-gateway-operations.md`

## Review cadence
- review this policy whenever a new automation class is proposed
- review before pilot or production-readiness signoff
- review after any incident where automation containment or rollback was required
