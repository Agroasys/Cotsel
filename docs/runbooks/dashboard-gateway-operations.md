# Dashboard Gateway Operations

## Purpose
Operate the `gateway/` service safely as the dashboard-facing control plane for Web3layer governance and compliance workflows.

This runbook covers:
- startup prerequisites,
- health/readiness verification,
- request tracing and log redaction,
- downstream timeout boundaries,
- queued governance execution,
- rollback and incident evidence capture.

## Runtime boundary
The gateway is a Web2 orchestration boundary. It does not change protocol logic and it does not custody governance private keys.

Authoritative dependencies:
- Postgres: gateway ledgers and idempotency/audit persistence
- Auth service: bearer-session validation
- Chain RPC: governance status reads and executor-backed governance mutations
- Executor process: `npm run -w gateway execute:governance-action -- <actionId>`

## Required configuration
Minimum gateway env contract:
- `GATEWAY_AUTH_BASE_URL`
- `GATEWAY_AUTH_REQUEST_TIMEOUT_MS`
- `GATEWAY_RPC_URL`
- `GATEWAY_RPC_READ_TIMEOUT_MS`
- `GATEWAY_CHAIN_ID`
- `GATEWAY_ESCROW_ADDRESS`
- `GATEWAY_ENABLE_MUTATIONS`
- `GATEWAY_WRITE_ALLOWLIST`
- `GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS`
- `GATEWAY_COMMIT_SHA`
- `GATEWAY_BUILD_TIME`

Executor-only env:
- `GATEWAY_USDC_ADDRESS`
- `GATEWAY_EXECUTOR_PRIVATE_KEY`
- `GATEWAY_EXECUTOR_TIMEOUT_MS`

Safety rules:
- If `GATEWAY_ENABLE_MUTATIONS=false`, all gateway mutation routes must reject writes.
- If `GATEWAY_WRITE_ALLOWLIST` is empty, mutations must reject writes even when enabled.
- The gateway process must never hold the governance signer key; only the separate executor process may do so.

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
curl -fsS http://127.0.0.1:${GATEWAY_PORT:-3600}/api/dashboard-gateway/v1/healthz
curl -fsS http://127.0.0.1:${GATEWAY_PORT:-3600}/api/dashboard-gateway/v1/readyz
curl -fsS http://127.0.0.1:${GATEWAY_PORT:-3600}/api/dashboard-gateway/v1/version
```

## Health and readiness interpretation
- `/healthz`: process is alive
- `/readyz`: Postgres, auth service, and chain RPC are reachable and consistent with gateway config
- `/version`: build, commit, and repository metadata

Readiness must stay green before enabling connected dashboard mode.

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

## Downstream timeout and retry boundaries
The gateway is intentionally conservative:
- Auth session validation timeout: `GATEWAY_AUTH_REQUEST_TIMEOUT_MS` (default `5000ms`)
- Chain read timeout: `GATEWAY_RPC_READ_TIMEOUT_MS` (default `8000ms`)
- Governance executor timeout: `GATEWAY_EXECUTOR_TIMEOUT_MS` (default `45000ms`)
- Automatic retries for gateway mutations: none
- Automatic retries for auth and RPC reads inside the gateway: none

Reason:
- downstream services already own their idempotency and retry policies
- the gateway must fail deterministically rather than amplify mutations

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

## Rollback procedure
If gateway behavior regresses after deploy:
1. Set `GATEWAY_ENABLE_MUTATIONS=false`.
2. Redeploy or restart gateway with the safe config.
3. Stop any executor invocation for queued actions until the release is assessed.
4. Inspect queued vs executed governance actions:

```bash
curl -fsS -H "Authorization: Bearer <session>" \
  "http://127.0.0.1:${GATEWAY_PORT:-3600}/api/dashboard-gateway/v1/governance/actions?status=requested"
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

## References
- `docs/api/web3layer-dashboard-gateway.openapi.yml`
- `docs/runbooks/dashboard-api-gateway-boundary.md`
- `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`
- `docs/runbooks/api-gateway-boundary.md`
