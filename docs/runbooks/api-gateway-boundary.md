# API Gateway Orchestration Boundary

## Purpose and scope
Define the operational boundary for API orchestration between the Web2 ingress layer and core services (`oracle`, `treasury`, `reconciliation`, `indexer`, `notifications`).

This runbook is the source of truth for boundary behavior under issue #78. A dedicated gateway runtime control plane is not implemented in-repo yet (tracked by #123), and a centralized dead-letter/error-handler workflow is tracked by #124.

## Routing ownership and service contract
Current runtime behavior is service-directed (no single in-repo gateway binary). The boundary contract below defines ownership and expected routing:

| Request class | Current endpoint owner | Contract boundary |
| --- | --- | --- |
| Oracle settlement actions | `oracle` (`/api/oracle/*`) | Mutating calls must carry idempotency context (`tradeId`, `requestId`) and service auth headers. |
| Treasury ledger + payout ops | `treasury` (`/api/treasury/v1/*`) | Calls must satisfy treasury auth policy when enabled; payout state changes are append-only. |
| Reconciliation execution | `reconciliation` worker (CLI/job) | No public HTTP mutation surface; execution is scheduled/operator-controlled. |
| Indexer reads | `indexer-graphql` (`/graphql`) | Read-only query surface for state evidence, never mutation authority. |
| Notifications emission | library/runtime hooks | Service-local emission with deterministic routing metadata; no direct public mutation API in this repo. |

Ownership rule:
- Gateway orchestration policy ownership: platform/ops maintainers (Milestone B governance scope).
- Service behavior ownership: each service owner remains responsible for validation and idempotency inside their runtime.

## Authentication propagation rules (headers/claims, what must never be forwarded)
Rules that apply to gateway-mediated traffic:
- Preserve only required upstream auth material:
  - Oracle contract: `Authorization: Bearer <API_KEY>`, `X-Timestamp`, `X-Signature`.
  - Treasury contract (when `AUTH_ENABLED=true`): `x-agroasys-timestamp`, `x-agroasys-signature`, optional `x-agroasys-nonce`, optional `X-Api-Key`.
- Never forward raw secrets, private keys, or internal signing material in headers/body logs.
- Never forward user cookies/session tokens to internal services that do not require them.
- For internal retries/replays, regenerate service signatures per request; do not replay stale signed headers.

## Correlation IDs + request IDs (exact fields, generation, logging expectations)
Correlation fields must align with `docs/observability/logging-schema.md`:
- `tradeId`
- `actionKey`
- `requestId`
- `txHash`
- `traceId`

Operational rules:
- Mutating oracle calls must include `requestId` in request body (already required by oracle API contract).
- If ingress receives no request correlation header, generate one at ingress and attach to downstream logs as `traceId`.
- Keep `requestId` stable across retry attempts for the same client intent; use `actionKey`/idempotency logic in downstream services to prevent duplication.

## Timeouts and retries (default ceilings; per-service overrides; retry budget)
Current deterministic behavior in-repo:
- Oracle retry loop: bounded by `RETRY_ATTEMPTS` (default `3`) with exponential backoff from `RETRY_DELAY` (default `1000ms`, max `30000ms`).
- Reconciliation: no mutating retry loop; reruns are daemon/one-shot controlled.
- Notifications: bounded retries per notifier configuration (`retryAttempts`, `retryDelayMs`, `maxRetryDelayMs`).
- Staging gate readiness retries use bounded shell retries (for example, `retry_cmd 30 2` in `scripts/staging-e2e-real-gate.sh`).

Boundary rule for future gateway runtime (#123):
- Do not add unbounded gateway retries for mutating endpoints.
- Keep gateway retry budget lower than or equal to downstream idempotent safety model.

## Failure modes: fallback, dead-letter, and "who owns the incident"
Current state:
- Full cross-service dead-letter queue is not implemented yet (tracked by #124).
- Oracle provides deterministic exhaustion state (`EXHAUSTED_NEEDS_REDRIVE`) plus manual redrive controls (`docs/runbooks/oracle-redrive.md`).
- Reconciliation and staging gate outputs provide drift/error evidence for incident triage.

Fallback policy:
- If gateway/orchestration behavior is unclear, route incident through runbooks with deterministic evidence:
  - `docs/incidents/first-15-minutes-checklist.md`
  - `docs/runbooks/oracle-redrive.md`
  - `docs/runbooks/reconciliation.md`

Incident ownership:
- Gateway boundary incident commander: platform/ops on-call.
- Service-specific correctness owner: affected service owner (oracle/treasury/reconciliation/indexer).

## Error taxonomy (client vs upstream vs infra) and expected response mapping
Use this classification for deterministic handoff:

| Error class | Typical source | Expected handling |
| --- | --- | --- |
| Client/contract error | Missing required fields, invalid auth headers, invalid request shape | Return deterministic 4xx with stable error code; do not retry automatically. |
| Upstream business/state error | Trade state precondition fails, idempotency conflict, payout transition invalid | Return deterministic error body; classify as service-owned incident if persistent. |
| Infrastructure/transient error | RPC timeout, DB connectivity, indexer unavailable | Retry only within bounded policy; escalate to on-call if threshold exceeded. |

## Observability requirements (log fields, metrics, traces)
Minimum log requirements:
- Include correlation fields from `docs/observability/logging-schema.md`.
- Redact auth/signature secrets from logs and artifacts.

Required operational evidence for gateway-boundary incidents:
- health/readiness outputs for affected services
- correlated logs using `tradeId`, `actionKey`, `requestId`, `txHash`, `traceId`
- release-gate reports when incident overlaps staging validation

Metric references (existing schema baseline):
- `auth_failures_total`
- `replay_rejects_total`
- `oracle_exhausted_retries_total`
- `oracle_redrive_attempts_total`
- `reconciliation_drift_classifications_total`

## Operational ownership matrix (RACI: gateway owner vs service owner vs on-call)
| Activity | Gateway owner (Ops/Platform) | Service owner | On-call |
| --- | --- | --- | --- |
| Define ingress-to-service routing contract | A/R | C | I |
| Maintain service auth contracts | C | A/R | I |
| Correlation field compliance in logs | A/R | A/R | C |
| Retry budget and timeout policy updates | A/R | C | C |
| Redrive/recovery execution during incident | C | A/R | A/R |
| Post-incident runbook update | A/R | C | C |

Legend: `A` accountable, `R` responsible, `C` consulted, `I` informed.

## Runbook quick actions (first 15 minutes checklist links)
1. Run incident triage baseline: `docs/incidents/first-15-minutes-checklist.md`.
2. If oracle path is impacted, execute `docs/runbooks/oracle-redrive.md`.
3. If drift/indexing mismatch is suspected, execute `docs/runbooks/reconciliation.md`.
4. Validate profile health and release-gate diagnostics:
   - `docs/runbooks/staging-e2e-release-gate.md`
   - `docs/runbooks/staging-e2e-real-release-gate.md`
