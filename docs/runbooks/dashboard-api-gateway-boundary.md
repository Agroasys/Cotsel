# Dashboard API Gateway Boundary

## Purpose

Define the contract boundary for the Cotsel-Dash admin/operator dashboard when it interacts with Cotsel through the dedicated `gateway/` Web2 service.

This document is the boundary companion to `docs/api/cotsel-dashboard-gateway.openapi.yml`.
For day-2 operations, deployment checks, logging/tracing, and rollback procedure, use `docs/runbooks/dashboard-gateway-operations.md`.
For generic gateway service-auth, downstream orchestration, retry, and audit-envelope rules, use `docs/runbooks/api-gateway-boundary.md`.

## Discovery outcome

- The dedicated in-repo dashboard gateway runtime exists as `gateway/` (Express + TypeScript).
- Existing repo HTTP services remain service-scoped (`auth`, `oracle`, `ricardian`, `treasury`).
- Governance actions are grounded in the escrow contract and `sdk/src/modules/adminSDK.ts`.
- Compliance is implemented in the gateway as an off-chain append-only decision ledger plus oracle progression block/resume control plane.

## Boundary summary

### Dashboard -> gateway

The Cotsel-Dash dashboard is the operator/admin client.

The dashboard must call only the documented gateway contract and must not call contract methods or internal services directly.

Dashboard responsibilities:

- present governance and compliance state
- collect operator reason/evidence/ticket references
- attach request and correlation identifiers
- submit authenticated requests with a session bearer token

Gateway responsibilities:

- authenticate and authorize operator actions
- persist audit metadata for every mutation
- prepare canonical direct-sign governance payloads for human privileged actions
- confirm and monitor direct-sign governance broadcasts after the admin wallet signs
- route executor-backed governance only for delegated/service/system actions that intentionally retain that flow
- assemble read models from chain, indexer, treasury, ricardian, and future compliance storage
- enforce idempotency, request tracing, and stable error shapes
- own downstream HTTP orchestration policy for service-routed reads and probes through `gateway/src/core/serviceRegistry.ts` and `gateway/src/core/serviceOrchestrator.ts`

Operations read surface:

- `GET /operations/summary` provides service health and incident summary for operator operations pages.
- Response states are explicit and deterministic: `healthy`, `degraded`, `unavailable`, `stale`.
- Every service status and incident summary snapshot includes source and freshness timestamps.
- `GET /overview` trade freshness must come from indexer watermarks (`lastIndexedAt`, `lastProcessedBlock`), not gateway request time.

Current connected-validation contract:

- local/docker parity:
  - gateway `http://127.0.0.1:3600/api/dashboard-gateway/v1`
  - auth `http://127.0.0.1:3005/api/auth/v1`
- approved remote staging:
  - gateway `https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1`
  - auth `https://cotsel.sys.agroasys.com/api/auth/v1`
  - Base Sepolia (`84532`)
  - explorer `https://sepolia-explorer.base.org/tx/`
  - read-only posture
- Connected mode must not silently fall back to preview behavior.

### Gateway -> on-chain / service backends

The gateway is an orchestration boundary, not the protocol itself.

Current backend truth in this repo:

- Auth/session: `auth`
- Governance execution: `sdk/src/modules/adminSDK.ts` + `contracts/src/AgroasysEscrow.sol`
- Ricardian document hashing: `ricardian`
- Treasury ledger and payout lifecycle: `treasury`
- Read-only chain/event evidence: `indexer`
- Oracle trade progression: `oracle`

## What is on-chain vs off-chain

### On-chain governed controls

These are existing contract-backed actions and must resolve to a transaction hash / chain event:

- `pause()`
- `proposeUnpause()`
- `approveUnpause()`
- `cancelUnpauseProposal()`
- `pauseClaims()`
- `unpauseClaims()`
- `claimTreasury()`
- `disableOracleEmergency()`
- `proposeOracleUpdate()`
- `approveOracleUpdate()`
- `executeOracleUpdate()`
- `cancelExpiredOracleUpdateProposal()`
- `proposeTreasuryPayoutAddressUpdate()`
- `approveTreasuryPayoutAddressUpdate()`
- `executeTreasuryPayoutAddressUpdate()`
- `cancelExpiredTreasuryPayoutAddressUpdateProposal()`

Primary source of truth:

- `contracts/src/AgroasysEscrow.sol`
- `contracts/tests/AgroasysEscrow.ts`
- `sdk/src/modules/adminSDK.ts`

### Off-chain policy and audit controls

These exist in the gateway runtime and remain off-chain controls:

- compliance decision records (`ALLOW`, `DENY`), with emergency override carried by `reasonCode=CMP_OVERRIDE_ACTIVE`
- compliance decision history for a trade
- block oracle progression for a trade
- resume oracle progression for a trade

These controls are stored in gateway-owned Postgres ledgers and consumed by the oracle/gateway orchestration layer.

Primary source of truth:

- `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`
- `docs/runbooks/api-gateway-boundary.md`

## Authentication and authorization

This dashboard boundary inherits the generic gateway auth/orchestration contract from
`docs/runbooks/api-gateway-boundary.md`. The dashboard-specific rules are:

- dashboard clients authenticate with an auth-service bearer session
- only auth role `admin` maps to gateway roles `operator:read` and `operator:write`
- mutations still require `GATEWAY_ENABLE_MUTATIONS=true` and caller membership in `GATEWAY_WRITE_ALLOWLIST`
- dashboard bearer sessions must never be forwarded downstream as service-to-service auth

## Verification model for operators

Every gateway action must be verifiable through one or more of:

- gateway action record / audit entry
- chain transaction hash
- emitted contract event
- treasury execution-evidence record
- ricardian hash record
- correlated logs using request/correlation IDs

### Governance verification examples

- Pause / claims pause:
  - verify gateway action status
  - verify audit `intent` / `outcome`
  - verify transaction hash
  - verify `Paused`, `ClaimsPaused`, or `ClaimsUnpaused` event
- Governance mutation execution model:
  - human privileged governance uses `prepare` -> wallet sign/broadcast -> `confirm`
  - verify resulting action transition, audit entries, verification state, monitoring state, and tx hash
  - direct-sign lifecycle must reflect backend-observed truth such as `prepared`, `broadcast_pending_verification`, `broadcast`, `pending_confirmation`, `confirmed`, `finalized`, `reverted`, or `stale`
  - executor-backed execution remains valid only for delegated/service roles that intentionally use the executor path
- Oracle recovery:
  - verify `OracleDisabledEmergency`, `OracleUpdateProposed`, `OracleUpdateApproved`, `OracleUpdated`
  - verify `oracleAddress` and `oracleActive` read model
- Treasury sweep:
  - verify `TreasuryClaimed`
  - verify current `treasuryPayoutAddress`
  - verify treasury execution evidence and export-eligibility state if payout workflow continues off-chain
- Treasury payout receiver rotation:
  - verify proposal approval count, timelock, execution status
  - verify `TreasuryPayoutAddressUpdated`

### Compliance verification examples

- Attestation status read:
  - verify `GET /compliance/trades/{tradeId}/attestation-status`
  - verify issuer, subject reference, `verifiedAt`, freshness, availability, expiry, and degraded reason
  - verify the route is treated as read-only evidence and not as a revalidation or mutation path
- Decision create:
  - verify append-only decision record with provider reference, reason code, evidence links, actor metadata, and explicit `outcome`
- Block oracle progression:
  - verify trade block state in gateway read model
  - verify that subsequent oracle progression requests are rejected or held by orchestration policy
- Resume oracle progression:
  - verify cleared block state and linked reason/evidence

## Required audit fields for every mutation

The full audit-envelope contract lives in
`docs/runbooks/api-gateway-boundary.md` and
`docs/observability/logging-schema.md`.

Dashboard-specific requirement:

- every dashboard mutation must carry operator reason, evidence links, and ticket reference into the gateway-owned audit ledgers
- when request logs and ledgers diverge in field naming, treat gateway ledger records as the stronger audit truth

## Downstream orchestration contract

The per-service downstream auth, timeout, retry, and replay contract is defined in
`docs/runbooks/api-gateway-boundary.md`.

Dashboard-specific implication:

- the dashboard only talks to the gateway contract
- the gateway owns all downstream service orchestration and evidence collection needed to satisfy that dashboard contract

## Resolved design choices

- The gateway is the canonical owner of dashboard-facing ledgers:
  - `governance_actions`
  - `compliance_decisions`
  - `oracle_progression_blocks`
  - `idempotency_keys`
  - `audit_log`
- Human governance execution uses the direct-sign prepare/confirm model and the gateway does not hold the signer key.
- Executor-backed queued execution remains a service-role path only and is not the default human governance model.
- Governance status and proposal reads use direct chain reads because the current generic SDK client does not expose the full read surface.
- Compliance decisions are append-only and resume is permitted only when policy conditions are satisfied by the latest effective `ALLOW` decision.

## Remote staging contract status

The approved remote staging coordinates and current read-only posture are maintained in
`docs/runbooks/dashboard-gateway-operations.md`.

This boundary document assumes the same posture:

- remote staging is suitable for connected-read and auth/session validation
- write proof remains blocked until mutations are explicitly enabled and exact allowlist principals are approved

## References

- `docs/api/cotsel-dashboard-gateway.openapi.yml`
- `docs/runbooks/dashboard-gateway-operations.md`
- `docs/runbooks/api-gateway-boundary.md`
- `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`
- `docs/runbooks/emergency-disable-unpause.md`
- `docs/runbooks/pull-over-push-claim-flow.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `auth/README.md`
- `sdk/src/modules/adminSDK.ts`
