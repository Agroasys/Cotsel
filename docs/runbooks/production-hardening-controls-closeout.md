# Production Hardening Controls Closeout

## Scope

This closeout covers the production-hardening control pass on branch
`production-hardening-controls`. The pass is intentionally limited to release
security gates, server-owned auth authority, audited admin provisioning,
break-glass access, Redis-capable rate limiting, immediate privileged-session
revocation, security observability, Docker/runtime wiring, and
contract-facing release evidence.

This pass does not redesign the product, treasury workflow, dashboard user
experience, settlement state machine, partner integrations, or smart contract
business logic.

## What Changed And Why

The dependency release gate is now enforcing for production dependency risk.
`scripts/security-deps-gate.mjs` runs `npm audit --omit=dev --json` and
`npm ls --all`, failing release validation for High or Critical production
advisories or an invalid dependency tree. `.github/workflows/release-gate.yml`
wires this as `ci/dependency-security`, and
`docs/security/dependency-vuln-policy.md` documents that exceptions must be
owned, time-bound, and supported by compatibility and reachability evidence.
The lockfile was also cleaned so the tree is reproducible under Node 20/npm 10:
older packages that require `bn.js` 4.x resolve to the 4.x line, newer Web3
packages keep 5.x, and `viem` is pinned to a version whose `ox` dependency
satisfies the Web3Auth/permissionless peer chain.

Auth authority is now server-owned for privileged roles. Public wallet login is
restricted to self-serve roles, and `SessionService.login` rejects direct
admin/oracle role requests. Existing trusted upstream session exchange remains
the normal production identity bridge from `agroasys-backend` to Cotsel auth,
because Agroasys remains the primary platform identity authority. Cotsel-local
admin provisioning is separated into an authenticated service-control plane.

The admin-control plane adds durable provisioning, deactivation, break-glass
grant, break-glass revoke, and break-glass review endpoints under
`/api/auth/v1/admin/*`. Requests require service-auth HMAC signing, timestamp
skew enforcement, persisted nonce replay protection, and an allowlisted API key
ID. Every privileged state transition records an audit row in
`auth_admin_audit_events` with actor, reason, prior role, new role, and
request metadata. The durable base role remains separate from temporary
break-glass elevation.

Privileged access removal now has immediate effect. Session resolution compares
the role captured at issuance with the current effective authority from the
profile store. Durable role downgrade, profile deactivation, break-glass grant,
break-glass revoke, and break-glass expiry revoke active sessions so old
bearer sessions do not quietly retain privileged authority.

Rate limiting now supports distributed Redis-backed enforcement and explicit
failure mode. The shared-edge limiter supports fail-closed by default and
fail-open only when configured. Auth and gateway pass Redis URLs and failure
mode config from environment variables, and both emit structured events when a
store failure causes fail-closed blocking or fail-open degradation.

Operational runbooks now describe durable admin provisioning and break-glass
procedures. They include who may initiate, approve, execute, and review each
path; how service-auth keys are stored and rotated; what signing, nonce, and
allowlist requirements exist; what reason/ticket evidence is mandatory; how
revocation works; how break-glass expires; and what evidence must be retained.

Security observability now includes the auth control events introduced by this
pass. `docs/runbooks/monitoring-alerting-baseline.md` covers
`auth.durable_admin_provisioned`, `auth.durable_admin_revoked`,
`auth.break_glass_granted`, `auth.break_glass_revoked`,
`auth.break_glass_expired`, `auth.service_auth_denied`,
`auth.nonce_replay_attempted`, and auth/gateway rate-limiter degraded modes.
The baseline validator now recognizes `auth` as an in-scope monitored service.

Runtime wiring now makes the new controls usable in deployed service profiles.
`.env.example`, `env/auth.env.example`, and `docker-compose.services.yml`
include auth admin-control settings, Redis-backed rate-limit settings, and
fail-open toggles. Redis remains the shared runtime support for distributed
limits and nonce/rate-limit behavior where configured.

Contract-facing release evidence remains under the supported Node runtime.
The repository declares Node `>=20 <23` and npm `>=10 <12`; CI uses Node 20.
Hardhat/contract validation for this pass must be run under Node 20 so release
evidence is not polluted by unsupported Node 25 warnings.

## Files And Modules Changed

- `.env.example`
- `.github/workflows/release-gate.yml`
- `auth/src/api/adminController.ts`
- `auth/src/api/controllerSupport.ts`
- `auth/src/api/legacyWalletAuthController.ts`
- `auth/src/api/routes.ts`
- `auth/src/config.ts`
- `auth/src/core/adminService.ts`
- `auth/src/core/profileStore.ts`
- `auth/src/core/sessionService.ts`
- `auth/src/database/queries.ts`
- `auth/src/database/schema.sql`
- `auth/src/httpSecurity.ts`
- `auth/src/metrics/counters.ts`
- `auth/src/middleware/middleware.ts`
- `auth/src/server.ts`
- `auth/src/types.ts`
- `auth/tests/adminControls.integration.test.ts`
- `auth/tests/queries.test.ts`
- `auth/tests/rateLimitWiring.test.ts`
- `auth/tests/routes.test.ts`
- `auth/tests/sessionService.test.ts`
- `docker-compose.services.yml`
- `docs/runbooks/auth-admin-provisioning.md`
- `docs/runbooks/auth-break-glass.md`
- `docs/runbooks/monitoring-alerting-baseline.md`
- `docs/security/dependency-vuln-policy.md`
- `env/auth.env.example`
- `gateway/src/config/env.ts`
- `gateway/src/server.ts`
- `package-lock.json`
- `package.json`
- `scripts/monitoring-baseline-validate.mjs`
- `scripts/security-deps-gate.mjs`
- `shared-edge/rateLimit.d.ts`
- `shared-edge/rateLimit.js`
- `shared-edge/rateLimit.redis.integration.test.js`
- `shared-edge/rateLimit.test.js`

## Tests And Proofs

The auth persistence integration test uses a real Postgres container and the
real auth schema. It proves durable admin provisioning persists role state,
service-auth allowlist denial is rejected, audit rows are written, nonce replay
is rejected, durable downgrade revokes old privileged sessions, break-glass
cannot be granted over an existing durable admin role, break-glass state is
stored separately from durable base role, break-glass expiry removes temporary
authority, post-incident review is audited, and deactivation immediately
invalidates future session resolution.

The shared-edge Redis integration test uses a real Redis container. It creates
two independent limiter instances with the same Redis-backed quota and proves
shared enforcement across instances. It also proves Redis-backed fail-closed
behavior when the store becomes unavailable and fail-open behavior only when
explicitly configured. Unit tests cover the same degraded-mode semantics with a
failing injected store.

Auth route wiring tests prove admin-control routes receive the admin throttle
policy. Session service tests cover role mismatch and inactive-profile
revocation behavior. Gateway tests continue to cover existing operator and
settlement behavior after the rate-limit failure-mode wiring change.

Required validation commands for this closeout:

```bash
nvm use 20.20.2
node --version
npm --version
npm ci
npm run -w auth lint
npm run -w auth test -- --runInBand
npm run -w auth build
npm run -w gateway lint
npm run -w gateway test -- --runInBand
npm run -w gateway build
npm run -w @agroasys/shared-edge lint
npm run -w @agroasys/shared-edge test -- --runInBand
npm run security:deps:gate
node scripts/monitoring-baseline-validate.mjs --runbook docs/runbooks/monitoring-alerting-baseline.md
npm run -w contracts test
```

## Intentionally Not Changed

This pass intentionally does not change contract escrow logic, token handling,
settlement workflow semantics, treasury/off-ramp execution, partner banking
integrations, dashboard UI, or Agroasys platform authentication ownership.
The trusted Agroasys session exchange path remains in place and remains the
primary production session bridge for Cotsel dashboard usage.

This pass also does not provision an external observability SaaS, create a new
security platform layer, or introduce broad framework abstractions. It adds the
minimum code, tests, docs, and release wiring required to make the hardening
controls auditable and operationally usable.

## Remaining Non-Blocking Backlog

- Attach live production secret-manager key IDs and rotation records when the
  admin-control plane is enabled outside local/staging environments.
- Add environment-specific alert routing in the external monitoring system
  that consumes the structured auth and gateway events described in the
  monitoring baseline.
- Complete the already-documented Hardhat major-upgrade reassessment when the
  plugin chain is compatible. The release-blocking gate is clean for production
  dependencies, but full `npm audit` still reports dev-toolchain advisories in
  the deferred Hardhat chain.
- Record live staging or production deployment evidence separately from this
  repo-local proof when promoting beyond repository validation.

## Risk Reduction

This pass reduces release risk by blocking known High/Critical production
dependency advisories, removing client-controlled privileged role assignment,
making admin and break-glass authority auditable, rejecting nonce replay,
forcing immediate revocation of stale privileged sessions, proving shared
Redis-backed rate limits, documenting degraded rate-limit behavior, and making
dangerous auth-control events visible to operators.
