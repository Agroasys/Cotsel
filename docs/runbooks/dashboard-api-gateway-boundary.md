# Dashboard API Gateway Boundary

## Purpose
Define the contract boundary for the Cotsel-Dash admin/operator dashboard when it interacts with Cotsel through the dedicated `gateway/` Web2 service.

This document is the boundary companion to `docs/api/cotsel-dashboard-gateway.openapi.yml`.
For day-2 operations, deployment checks, logging/tracing, and rollback procedure, use `docs/runbooks/dashboard-gateway-operations.md`.

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
- translate governance requests into durable queued actions and executor-backed AdminSDK calls
- assemble read models from chain, indexer, treasury, ricardian, and future compliance storage
- enforce idempotency, request tracing, and stable error shapes

Operations read surface:
- `GET /operations/summary` provides service health and incident summary for operator operations pages.
- Response states are explicit and deterministic: `healthy`, `degraded`, `unavailable`, `stale`.
- Every service status and incident summary snapshot includes source and freshness timestamps.
- `GET /overview` trade freshness must come from indexer watermarks (`lastIndexedAt`, `lastProcessedBlock`), not gateway request time.

Current connected-validation constraint:
- Cotsel-Dash may run connected mode only against explicit local/docker gateway and auth-service URLs until real remote staging coordinates are recorded.
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

### External client auth
The gateway should align with the repo’s existing auth service model:
- login flow: wallet-signature challenge/response
- session token: `Authorization: Bearer <sessionId>`
- gateway role mapping: auth role `admin` -> `operator:read` + `operator:write`
- gateway write safety gate: mutations additionally require `GATEWAY_ENABLE_MUTATIONS=true` and caller membership in `GATEWAY_WRITE_ALLOWLIST`

Source of truth:
- `auth/src/api/controller.ts`
- `auth/src/middleware/middleware.ts`
- `auth/README.md`

### Internal service auth
The gateway must not forward dashboard bearer sessions to internal services that use service-to-service auth.

Current internal service auth patterns in repo:
- `ricardian` and `treasury`: HMAC/API-key service auth
- `oracle`: service auth headers per `docs/runbooks/api-gateway-boundary.md`

## Verification model for operators
Every gateway action must be verifiable through one or more of:
- gateway action record / audit entry
- chain transaction hash or extrinsic hash
- emitted contract event
- treasury ledger record
- ricardian hash record
- correlated logs using request/correlation IDs

### Governance verification examples
- Pause / claims pause:
  - verify gateway action status
  - verify audit `intent` / `outcome`
  - verify transaction hash
  - verify `Paused`, `ClaimsPaused`, or `ClaimsUnpaused` event
- Governance mutation execution model:
  - gateway persists action as `QUEUED`
  - executor process runs `npm run -w gateway execute:governance-action -- <actionId>`
  - verify resulting action transition, audit entries, explicit `outcome`, and tx hash
- Oracle recovery:
  - verify `OracleDisabledEmergency`, `OracleUpdateProposed`, `OracleUpdateApproved`, `OracleUpdated`
  - verify `oracleAddress` and `oracleActive` read model
- Treasury sweep:
  - verify `TreasuryClaimed`
  - verify current `treasuryPayoutAddress`
  - verify treasury ledger/export state if payout workflow continues off-chain
- Treasury payout receiver rotation:
  - verify proposal approval count, timelock, execution status
  - verify `TreasuryPayoutAddressUpdated`

### Compliance verification examples
- Decision create:
  - verify append-only decision record with provider reference, reason code, evidence links, actor metadata, and explicit `outcome`
- Block oracle progression:
  - verify trade block state in gateway read model
  - verify that subsequent oracle progression requests are rejected or held by orchestration policy
- Resume oracle progression:
  - verify cleared block state and linked reason/evidence

## Required audit fields for every mutation
The gateway must persist every mutation in a form that can populate
`AuditEnvelopeV1` from `docs/observability/logging-schema.md`.

Minimum persisted fields:
- `requestId`
- `correlationId`
- `actionKey` or equivalent gateway action identifier
- `actorSessionId`
- `actorWallet`
- `actorRole`
- `intent`
- `outcome`
- `reason`
- `evidenceLinks`
- `ticketRef`
- `createdAt`
- `requestedBy`
- `approvedBy`, if applicable
- resulting `txHash` / `blockNumber`, if applicable

Gateway-specific note:
- The current gateway runtime already persists actor and audit metadata in its
  ledgers, but generic request logs still use local field names such as
  `userId`, `walletAddress`, and `gatewayRoles`.
- Treat the ledger records as the stronger audit truth when field names diverge.

## Resolved design choices
- The gateway is the canonical owner of dashboard-facing ledgers:
  - `governance_actions`
  - `compliance_decisions`
  - `oracle_progression_blocks`
  - `idempotency_keys`
  - `audit_log`
- Governance execution uses queued execution; the gateway does not hold private keys.
- Governance status and proposal reads use direct chain reads because the current generic SDK client does not expose the full read surface.
- Compliance decisions are append-only and resume is permitted only when policy conditions are satisfied by the latest effective `ALLOW` decision.

## Remaining external deployment dependency
- Current approved connected-validation target is local/docker only.
- Concrete remote staging deployment coordinates (gateway base URL and auth URL binding) are still external operational inputs and must be recorded before remote staging connected-mode validation.
- Mutations remain disabled by default; later enablement requires both `GATEWAY_ENABLE_MUTATIONS=true` and exact allowlist principal IDs for Aston and `czpyioe`.

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
