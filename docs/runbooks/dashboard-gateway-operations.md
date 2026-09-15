# Dashboard Gateway Operations

## Purpose

Operate the `gateway/` service safely as the dashboard-facing control plane for Cotsel governance and compliance workflows.

This runbook covers:

- startup prerequisites,
- health/readiness verification,
- request tracing and log redaction,
- downstream timeout boundaries,
- direct-sign governance monitoring,
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

- gateway target: `https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1`
- auth-service target: `https://cotsel.sys.agroasys.com/api/auth/v1`
- chain target: Base Sepolia (`84532`)
- explorer base: `https://sepolia-explorer.base.org/tx/`
- mode: read-only first
- governance signer mode: registered human hardware-wallet direct-sign only

This means:

- Cotsel-Dash connected validation targets the approved remote staging contract above.
- Mutations stay disabled by default.
- Remote staging writes stay blocked until an explicit posture change is approved and the gateway allowlist is populated with exact auth principal IDs.

## Runtime boundary

The gateway is a Web2 orchestration boundary. It does not change protocol logic and it does not custody governance private keys.

Authoritative dependencies:

- Postgres: gateway ledgers and idempotency/audit persistence
- Failed-operation replay: `node scripts/gateway-dead-letter-workflow.mjs list|replay`
- Auth service: bearer-session validation
- Chain RPC: governance pre-flight reads, independent broadcast verification,
  monitoring, and settlement operations
- Governance mutation process: prepare and confirm only; no queue, executor,
  replay worker, CLI signer, KMS signer, or server-held governance key

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
- `GATEWAY_USDC_ADDRESS`
- `GATEWAY_ENABLE_MUTATIONS`
- `GATEWAY_WRITE_ALLOWLIST`
- `GATEWAY_OPERATOR_SIGNER_ENVIRONMENT`
- `GATEWAY_GOVERNANCE_PREPARATION_TTL_SECONDS`
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
- The gateway process must never hold the human governance signer key.
- No governance executor secret is part of the supported current runtime.
- Approved write operators for later enablement are Aston and `czpyioe`, but `GATEWAY_WRITE_ALLOWLIST`
  must contain the exact local auth principal IDs used by the auth service. Do not guess identifiers.

### Sponsored participant USDC sends

`POST /api/dashboard-gateway/v1/wallet/usdc/gasless-transfers` is a server-to-server ingress used
only by Agroasys. It uses the same HMAC service authentication, nonce replay protection, mutation
kill switch, and idempotency store as settlement ingress. It is not a browser route and must never be
added to the dashboard session-auth surface.

The participant signs an exact EIP-3009 authorization containing the sending wallet, destination,
amount, one-time nonce, chain, token, and short expiry. Cotsel only supplies the native network gas
and broadcasts that authorization. Incoming USDC receipts do not call this route and consume no
sponsored gas.

Agroasys records the sponsorship source as `pooled_settlement_support_fees`. This is pooled treasury
funding, not a promise that one order's USD 4 support fee is reserved for one transfer. Operators must
reconcile the returned request ID, transaction hash, gas used, effective gas price, native cost, and
executor address against the Agroasys transfer record. A successful HTTP response without complete
receipt evidence is invalid.

Operational controls:

- monitor `GET /api/dashboard-gateway/v1/operations/gasless-relayer/readiness` before enabling sends;
- use the dedicated relayer KMS signer in staging and production;
- refill or pause using the thresholds in `gateway-governance-signer-custody.md`;
- on an ambiguous timeout, retry with the same platform transfer ID and idempotency key; the USDC
  authorization nonce prevents a second token spend;
- if broadcast may have succeeded but receipt evidence is unavailable, hold the Agroasys ledger
  reserve and reconcile on-chain before releasing or retrying with a new authorization.

## Startup procedure

1. Confirm the Node 22.23.2 baseline.
2. Confirm Postgres database exists for `GATEWAY_DB_NAME`.
3. Start gateway service.
4. Run migrations on startup.
5. Verify liveness, then readiness.

Example local commands:

```bash
corepack enable
corepack prepare pnpm@10.34.4 --activate
pnpm install --frozen-lockfile
scripts/cotsel.sh up
scripts/cotsel.sh health
export DASHBOARD_GATEWAY_LOCAL_BASE_URL="${DASHBOARD_GATEWAY_LOCAL_BASE_URL:-<local dashboard gateway base>}"
curl -fsS "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/healthz"
curl -fsS "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/readyz"
curl -fsS "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/version"
curl -fsS -H "Authorization: Bearer <session>" \
  "${DASHBOARD_GATEWAY_LOCAL_BASE_URL}/operations/summary"
```

## Health and readiness interpretation

- `/healthz`: process is alive
- `/readyz`: Postgres, auth service, and chain RPC are reachable and consistent with gateway config
- `/version`: build, commit, and repository metadata

Readiness must stay green before enabling connected dashboard mode.

Approved remote staging health evidence as of `2026-04-02`:

- `GET https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1/healthz` -> `200 OK`
- `GET https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1/readyz` -> `200 OK`
- `GET https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1/version` -> `200 OK`
- Protected read endpoints return `401 Unauthorized` without a bearer session and succeed with a real auth-service admin session.

## Authentication and authorization

- External dashboard clients authenticate with auth-service bearer sessions.
- Only auth role `admin` maps to gateway roles:
  - `operator:read`
  - `operator:write`
- Mutation routes additionally require:
  - `GATEWAY_ENABLE_MUTATIONS=true`
  - caller membership in `GATEWAY_WRITE_ALLOWLIST`
  - route-specific operator capabilities from auth session truth:
    - `governance:write` for governance direct-sign prepare/confirm routes
    - `compliance:write` for compliance mutation routes
    - `operations:replay` for failed-operation replay
    - `treasury:prepare`, `treasury:approve`, `treasury:execute_match`, or `treasury:close`
      for the matching treasury workflow routes
  - the exact active signer-register binding for the submitted wallet, action
    class, and environment

Operational implication:

- a valid admin session alone is not sufficient to mutate protocol controls.
- broad `operator:write` access does not imply replay, governance, compliance, or treasury authority.
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

Redacted log classes:

- bearer auth headers and session credentials
- API credential material
- HMAC/shared-secret material
- password or secret-bearing fields

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

## Governance direct-sign procedure

**IMPLEMENTED IN SOURCE / NOT DEPLOYMENT-ACCEPTED.** Do not use this procedure
until the reviewed release and migrations are deployed, the signer register is
populated with named independent hardware-wallet custodians, and the release
evidence window is explicitly approved.

1. Gateway validates authz and payload.
2. Gateway requires the exact active signer binding and derives a deterministic
   `intentKey` from the action, chain, signer, binding, method, and parameters.
3. If an open action already exists for the same `intentKey`, the gateway returns that existing action instead of creating a duplicate row.
4. Otherwise the gateway writes `governance_actions` + `audit_log` atomically with status `prepared` and flow type `direct_sign`.
5. The response includes the canonical signing payload and prepared payload hash.
6. The admin reviews the complete transaction on the hardware device, then signs
   and broadcasts with that device through compatible wallet software.
7. The caller submits `POST /governance/actions/:actionId/confirm`.
8. Gateway records `broadcast` or `broadcast_pending_verification` and starts backend monitoring.
9. Operators verify tx hash, verification state, monitoring state, receipt, and
   chain confirmation depth through finalization.

The gateway never signs or broadcasts governance transactions. Do not use an
old checkout, manual contract call, direct database write, executor, queue,
replay worker, KMS key, or CLI command as a substitute.

## Rollback procedure

If gateway behavior regresses after deploy:

1. Set `GATEWAY_ENABLE_MUTATIONS=false`.
2. Redeploy or restart gateway with the safe config.
3. Keep governance mutation paths blocked until the release is assessed.
4. Revert the release if required.
5. Capture request IDs and available runtime evidence before retrying any
   supported operation. Do not fabricate governance action evidence.

## Verification checklist

- `pnpm --filter ./gateway run lint`
- `pnpm --filter ./gateway run test`
- `pnpm --filter ./gateway run build`
- `scripts/cotsel.sh health`
- `curl /healthz`
- `curl /readyz`
- `curl /version`
- `curl /operations/summary` (authenticated admin session)

## References

- `docs/api/cotsel-dashboard-gateway.openapi.yml`
- `docs/runbooks/dashboard-api-gateway-boundary.md`
- `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`
- `docs/runbooks/api-gateway-boundary.md`
- `docs/runbooks/gateway-governance-signer-custody.md`
