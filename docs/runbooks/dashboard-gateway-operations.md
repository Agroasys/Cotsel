# Dashboard Gateway Operations

## Purpose
Operate the `gateway/` service safely as the dashboard-facing control plane for Cotsel governance and compliance workflows.

This runbook covers:
- startup prerequisites,
- health/readiness verification,
- request tracing and log redaction,
- downstream timeout boundaries,
- queued governance execution,
- rollback and incident evidence capture.

Automation-governance source of truth:
- `docs/runbooks/programmability-governance.md`

## Current connected-validation target
Approved current-state contracts:

Local parity contract:
- gateway target: `http://127.0.0.1:3600/api/dashboard-gateway/v1`
- auth-service target: `http://127.0.0.1:3005/api/auth/v1`
- runtime scope: local/docker parity only

Approved remote staging contract:
- gateway target: approved remote staging gateway base from the private ops inventory
- auth-service target: approved remote staging auth base from the private ops inventory
- chain target: Base Sepolia (`84532`)
- explorer base: `https://sepolia-explorer.base.org/tx/`
- mode: read-only first
- executor mode: manual only

Local parity source of truth:
- `docs/runbooks/dashboard-local-parity.md`

This means:
- Cotsel-Dash connected validation may target either the local/docker parity contract or the approved remote staging contract above.
- Mutations stay disabled by default.
- Remote staging writes stay blocked until an explicit posture change is approved and the gateway allowlist is populated with exact auth principal IDs.

## Runtime boundary
The gateway is a Web2 orchestration boundary. It does not change protocol logic and it does not custody governance private keys.

Authoritative dependencies:
- Postgres: gateway ledgers and idempotency/audit persistence
- Failed-operation replay: `node scripts/gateway-dead-letter-workflow.mjs list|replay`
- Auth service: bearer-session validation
- Chain RPC: governance status reads and executor-backed governance mutations
- Executor process: `npm run -w gateway execute:governance-action -- <actionId>`

## Required configuration
Minimum gateway env contract:
- `GATEWAY_AUTH_BASE_URL`
- `GATEWAY_AUTH_REQUEST_TIMEOUT_MS`
- `GATEWAY_SETTLEMENT_RUNTIME` or (`GATEWAY_RPC_URL` + `GATEWAY_CHAIN_ID`)
- `GATEWAY_RPC_URL`
- `GATEWAY_RPC_FALLBACK_URLS`
- `GATEWAY_RPC_READ_TIMEOUT_MS`
- `GATEWAY_CHAIN_ID`
- `GATEWAY_EXPLORER_BASE_URL`
- `GATEWAY_ESCROW_ADDRESS`
- `GATEWAY_ENABLE_MUTATIONS`
- `GATEWAY_WRITE_ALLOWLIST`
- `GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS`
- `GATEWAY_COMMIT_SHA`
- `GATEWAY_BUILD_TIME`
- `GATEWAY_INDEXER_REQUEST_TIMEOUT_MS`
- `GATEWAY_INDEXER_GRAPHQL_URL`

Optional operations-health probe URLs:
- `GATEWAY_ORACLE_BASE_URL`
- `GATEWAY_RECONCILIATION_BASE_URL`
- `GATEWAY_TREASURY_BASE_URL`
- `GATEWAY_RICARDIAN_BASE_URL`
- `GATEWAY_NOTIFICATIONS_BASE_URL`

Optional downstream service-auth contract:
- `GATEWAY_ORACLE_SERVICE_API_KEY`
- `GATEWAY_ORACLE_SERVICE_API_SECRET`
- `GATEWAY_TREASURY_SERVICE_API_KEY`
- `GATEWAY_TREASURY_SERVICE_API_SECRET`
- `GATEWAY_RICARDIAN_SERVICE_API_KEY`
- `GATEWAY_RICARDIAN_SERVICE_API_SECRET`

Gateway-owned downstream policy knobs:
- `GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET`
- `GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET`
- `GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS`
- `GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS`

When optional probe URLs are not set, the operations summary endpoint returns deterministic `unavailable`
for the corresponding service with a stable explanatory detail.

Executor-only env:
- `GATEWAY_USDC_ADDRESS`
- `GATEWAY_EXECUTOR_PRIVATE_KEY`
- `GATEWAY_EXECUTOR_TIMEOUT_MS`

Runtime notes:
- `GATEWAY_SETTLEMENT_RUNTIME` is the canonical selector for active Base v1 runtimes.
- `GATEWAY_RPC_URL`, `GATEWAY_RPC_FALLBACK_URLS`, and `GATEWAY_EXPLORER_BASE_URL` are override inputs, not separate runtime truth.
- Public Base RPC endpoints are acceptable for local/dev and emergency diagnostics only.
- The controlled Base Sepolia pilot runtime must use one managed primary provider and one independent managed fallback provider, per M0.

Signer custody source of truth:
- `docs/runbooks/gateway-governance-signer-custody.md`

Safety rules:
- If `GATEWAY_ENABLE_MUTATIONS=false`, all gateway mutation routes must reject writes.
- If `GATEWAY_WRITE_ALLOWLIST` is empty, mutations must reject writes even when enabled.
- The gateway process must never hold the governance signer key; only the separate executor process may do so.
- `GATEWAY_EXECUTOR_PRIVATE_KEY` is an approved local/staging bootstrap path only, not a steady-state production custody model.
- Approved write operators for later enablement are Aston and `czpyioe`, but `GATEWAY_WRITE_ALLOWLIST`
  must contain the exact local auth principal IDs used by the auth service. Do not guess identifiers.

## Startup procedure
1. Confirm Node 20 baseline.
2. Confirm Postgres database exists for `GATEWAY_DB_NAME`.
3. Start gateway service.
4. Run migrations on startup.
5. Verify liveness, then readiness.

Example local commands:

```bash
nvm use 20
npm ci
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev
export DASHBOARD_GATEWAY_LOCAL_BASE_URL="${DASHBOARD_GATEWAY_LOCAL_BASE_URL:-<local dashboard gateway base>}"
curl -fsS "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/healthz"
curl -fsS "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/readyz"
curl -fsS "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/version"
curl -fsS -H "Authorization: Bearer <session>" \
  "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/operations/summary"
```

Parity-enabled local browser verification:
- standard `local-dev` keeps the trade registry empty for fast iteration
- set `LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity` to expose the canonical seeded trade `TRD-LOCAL-9001`
- use `npm run dashboard:parity:session` and `npm run dashboard:parity:gate` before running dashboard live local-contract verification
- use `npm run dashboard:parity:ci` for the Cotsel-owned CI-adjacent orchestration path that also runs the Dash live suite
- treat `scripts/docker-services.sh health local-dev` as the broader whole-profile health check, not the dashboard parity gate
- canonical steps and failure interpretation live in `docs/runbooks/dashboard-local-parity.md`

## Health and readiness interpretation
- `/healthz`: process is alive
- `/readyz`: Postgres, auth service, and chain RPC are reachable and consistent with gateway config
- `/version`: build, commit, and repository metadata

Readiness must stay green before enabling connected dashboard mode.

Approved remote staging health evidence as of `2026-04-02`:
- `GET <approved remote gateway>/healthz` -> `200 OK`
- `GET <approved remote gateway>/readyz` -> `200 OK`
- `GET <approved remote gateway>/version` -> `200 OK`
- Protected read endpoints return `401 Unauthorized` without a bearer session and succeed with a real auth-service admin session.

## Authentication and authorization
- External dashboard clients authenticate with auth-service bearer sessions.
- Only auth role `admin` maps to gateway roles:
  - `operator:read`
  - `operator:write`
- Mutation routes additionally require:
  - `GATEWAY_ENABLE_MUTATIONS=true`
  - caller membership in `GATEWAY_WRITE_ALLOWLIST`

Operational implication:
- a valid admin session alone is not sufficient to mutate protocol controls.
- connected validation remains read-only until governance/compliance read verification is complete.

## Request tracing and log policy
Every request must carry or receive:
- `x-request-id`
- `x-correlation-id`

Structured logs must include:
- `requestId`
- `correlationId`
- route
- method
- statusCode
- durationMs
- actor identifiers when authenticated

Redacted log keys:
- `authorization`
- `token`
- `accessToken`
- `refreshToken`
- `apiKey`
- `secret`
- `password`
- `hmacSecret`

Evidence capture for incidents:
- request ID
- correlation ID
- actor identity/role
- gateway action ID, if mutation
- tx hash / block number, if applicable
- related ticket/incident URL

Use:
- `docs/incidents/incident-evidence-template.md` for incident closeout
- `docs/runbooks/operator-audit-evidence-template.md` for operator-reviewed control-plane actions

## Downstream timeout and retry boundaries
The gateway is intentionally conservative:
- Auth session validation timeout: `GATEWAY_AUTH_REQUEST_TIMEOUT_MS` (default `5000ms`)
- Chain read timeout: `GATEWAY_RPC_READ_TIMEOUT_MS` (default `8000ms`)
- Governance executor timeout: `GATEWAY_EXECUTOR_TIMEOUT_MS` (default `45000ms`)
- Downstream read timeout: `GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS` (default `5000ms`)
- Downstream mutation timeout: `GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS` (default `8000ms`)
- Automatic retries for gateway mutations: `GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET` (default `0`)
- Automatic retries for orchestrated downstream reads: `GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET` (default `1`)
- Automatic retries for auth and RPC reads inside the gateway: none unless the owning client already defines them

Reason:
- downstream services already own their idempotency and retry policies
- the gateway must fail deterministically rather than amplify mutations
- gateway-owned mutation and callback dead letters are replayed only through `docs/runbooks/gateway-dead-letter-workflow.md`

## Attestation verification and outage stance
For compliance and future attestation read surfaces, the gateway must preserve
the issuer’s attestation reference metadata without turning query time into fake
verification truth.

Operational rules:
- The gateway may expose last-known attestation reference metadata, but it must
  not imply successful current verification when issuer/provider checks are
  unavailable.
- Missing, stale, expired, or untrusted attestation state remains fail-closed
  for new trade-gating decisions.
- Read-only operator pages must distinguish:
  - last-known reference metadata
  - last successful verification time
  - current degraded or unavailable state
- During outage, operators must capture issuer ID, subject reference, provider
  reference, evidence reference, expiry, and affected `tradeId`/`correlationId`
  values in the incident or audit evidence packet.

Escalation:
- Follow the compliance outage thresholds in
  `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`.
- Do not re-enable writes or approve overrides on the assumption that a manual
  dashboard refresh constitutes fresh verification.

## Governance queue and executor procedure
Mutation requests do not execute governance transactions inline.

Flow:
1. Gateway validates authz and payload.
2. Gateway derives a deterministic `intentKey` from governance category, contract method, and relevant parameters.
3. If an open action already exists for the same `intentKey`, the gateway returns that existing action instead of creating a duplicate row.
4. Otherwise the gateway writes `governance_actions` + `audit_log` atomically with status `requested`.
5. Requested actions receive an `expires_at` deadline derived from `GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS`.
6. Operators may inspect or clean stale requested actions with:

```bash
node gateway/scripts/governance-cleanup.mjs --dry-run
node gateway/scripts/governance-cleanup.mjs --apply
```

7. Cleanup only marks expired `requested` actions as `stale` and appends an audit record with reason code `QUEUE_EXPIRED`.
8. Operator/executor runs:

```bash
npm run -w gateway execute:governance-action -- <actionId>
```

9. Executor refuses expired `requested` actions, marks them `stale`, and appends an audit record.
10. Executor updates the action record and audit log atomically.
11. Operator verifies tx hash, status, and chain event.

Signer-custody requirements before step 8:
- confirm the executor signer address matches the approved admin address for the queued action
- confirm the signer source satisfies `docs/runbooks/gateway-governance-signer-custody.md`
- record the approval or incident reference before starting the executor session

## Rollback procedure
If gateway behavior regresses after deploy:
1. Set `GATEWAY_ENABLE_MUTATIONS=false`.
2. Redeploy or restart gateway with the safe config.
3. Stop any executor invocation for queued actions until the release is assessed.
4. Inspect queued vs executed governance actions:

```bash
export DASHBOARD_GATEWAY_LOCAL_BASE_URL="${DASHBOARD_GATEWAY_LOCAL_BASE_URL:-<local dashboard gateway base>}"
curl -fsS -H "Authorization: Bearer <session>" \
  "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/governance/actions?status=requested"
```

5. Revert the release if required.
6. Capture request IDs, action IDs, tx hashes, and database audit evidence before retrying execution.

## Verification checklist
- `npm run -w gateway lint`
- `npm run -w gateway test`
- `npm run -w gateway build`
- `scripts/docker-services.sh health <profile>`
- `curl /healthz`
- `curl /readyz`
- `curl /version`
- `curl /operations/summary` (authenticated admin session)

## References
- `docs/runbooks/dashboard-local-parity.md`
- `docs/api/cotsel-dashboard-gateway.openapi.yml`
- `docs/runbooks/dashboard-api-gateway-boundary.md`
- `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`
- `docs/runbooks/api-gateway-boundary.md`
- `docs/runbooks/gateway-governance-signer-custody.md`
