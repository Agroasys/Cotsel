# Runtime Truth And Deployment Guide

## Purpose

This runbook is the cross-service runtime truth for the active Cotsel repo.

Use it when you need one answer to:

- what services actually exist
- which ones are required in local, staging, and production-candidate operation
- how identity and service-auth boundaries work
- how database security is enforced
- which commands are the approved repo-local bring-up and validation paths
- what is still backlog and must not be claimed as finished runtime truth

This document is intentionally operational. It is not an architecture essay.

## Active runtime scope

Active Base-era runtime services in this repo:

- `auth`
- `gateway`
- `oracle`
- `reconciliation`
- `ricardian`
- `treasury`
- `notifications`
- `indexer-pipeline`
- `indexer-graphql`
- shared infrastructure: `postgres`, `redis`

Active contract/runtime target:

- Base is the only active v1 settlement target in this repo
- Base Sepolia is the current pilot/runtime proof target
- Base mainnet launch requires the separate go/no-go and rollback approvals in:
  - `docs/runbooks/base-mainnet-go-no-go.md`
  - `docs/runbooks/base-mainnet-cutover-and-rollback.md`

Out of active runtime scope:

- retired legacy settlement paths are out of active runtime scope and must not reappear in live profiles
- backlog completion items such as treasury/off-ramp completion that are not yet closed runtime truth

## Service map

| Service            | Runtime role                              | Required in local parity                                  | Required in staging-e2e-real | Production-candidate role |
| ------------------ | ----------------------------------------- | --------------------------------------------------------- | ---------------------------- | ------------------------- |
| `auth`             | Cotsel bearer session service             | yes                                                       | yes                          | yes                       |
| `gateway`          | dashboard/operator control plane          | yes                                                       | yes                          | yes                       |
| `oracle`           | trade-progression attestation runner      | yes                                                       | yes                          | yes                       |
| `reconciliation`   | drift detection and evidence worker       | optional in narrow local work, expected in profile health | yes                          | yes                       |
| `ricardian`        | document hash / record service            | yes                                                       | yes                          | yes                       |
| `treasury`         | ledger and payout lifecycle service       | yes                                                       | yes                          | yes                       |
| `notifications`    | outbound event delivery hooks             | yes when gate is enabled                                  | yes                          | yes                       |
| `indexer-pipeline` | chain event ingestion                     | mocked in plain local-dev, real in staging-e2e-real       | yes                          | yes                       |
| `indexer-graphql`  | read model / evidence query surface       | mocked in plain local-dev, real in staging-e2e-real       | yes                          | yes                       |
| `postgres`         | system of record                          | yes                                                       | yes                          | yes                       |
| `redis`            | nonce/rate-limit support where configured | yes                                                       | yes                          | yes                       |

## Identity and auth boundary

### Production truth

- Agroasys is the primary end-user identity authority
- `auth` issues Cotsel bearer sessions
- the primary production path is trusted upstream session exchange:
  - `POST /api/auth/v1/session/exchange/agroasys`
- `gateway` consumes those bearer sessions and applies route-level authorization

### Compatibility truth

The wallet-signature login path in `auth` remains available only as a compatibility path:

- `GET /api/auth/v1/challenge`
- `POST /api/auth/v1/login`

This path is disabled by default in production candidates and must not be described as the normal production login path.
It is allowed only when `LEGACY_WALLET_LOGIN_ENABLED=true` in `development` or `test`.

### Governance truth

Human privileged governance uses the direct-sign model:

1. authenticated admin requests `prepare`
2. gateway validates and records audit intent
3. admin wallet signs and broadcasts
4. dashboard or caller submits `confirm`
5. backend verifies, monitors, reconciles, and audits the tx lifecycle

Executor-backed governance remains only for delegated/service/system roles where that flow is still intentionally used.

## Database security truth

The service-owned operational databases now use:

- separate runtime and migration DB users
- service-scoped Postgres session settings via `@agroasys/shared-db`
- forced row-level security on sensitive service-owned tables

Source of truth:

- `docs/runbooks/postgres-service-roles-and-rls.md`

Production-candidate expectation:

- services run with runtime DB users only
- migrations run with migration DB users only
- cross-service DB reads fail
- missing `app.service_name` fails

## Service-to-service auth truth

Canonical source of truth:

- `docs/runbooks/service-auth-matrix.md`

Current high-level posture:

- `auth` trusted upstream session exchange uses shared HMAC/API-key auth
- `gateway -> treasury` uses shared-auth HMAC/API-key auth
- `gateway -> ricardian` uses shared-auth HMAC/API-key auth
- `gateway -> oracle` uses the existing oracle bearer+HMAC contract
- gateway never forwards dashboard bearer sessions to those internal services

## Browser edge policy truth

- exposed browser-facing services use explicit origin allowlists
- `*_CORS_ALLOW_NO_ORIGIN` now defaults to `false`
- no-origin allowances are opt-in only and should be used only when a specific
  tool or non-browser client path truly requires them
- server-to-server traffic does not rely on CORS and should not be used to
  justify broad browser-origin policy

## Environment profiles

### Local development

Use for fast engineering iteration:

```bash
cp .env.example .env
cp .env.local.example .env.local
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev
```

Narrow dashboard parity path:

```bash
npm run dashboard:parity:session
npm run dashboard:parity:gate
```

### Staging release profile

Use for real indexer/reconciliation validation:

```bash
cp .env.example .env
cp .env.staging-e2e-real.example .env.staging-e2e-real
scripts/validate-env.sh staging-e2e-real
scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
scripts/notifications-gate.sh staging-e2e-real
```

### Production-candidate repo proof

This repo does not define one-button production deployment.
The production-candidate expectation is:

- the env contract is satisfied
- service/runtime truth is documented
- release-gate validation is green
- go/no-go evidence is attached

If promotion is executed outside this repo, the external deployment/change record must be the cited operational truth.

## Approved repo-local validation paths

Baseline workspace validation:

```bash
npm ci
npm run lint
```

Release-gate-aligned validation paths:

- `.github/workflows/release-gate.yml`
- `scripts/validate-env.sh staging-e2e-real`
- `scripts/staging-e2e-real-gate.sh`
- `scripts/postgres-backup-restore-smoke.sh`
- `scripts/notifications-gate.sh staging-e2e-real`
- `npm run pilot:rehearsal -- --window-id <window-id> --config-only`

## Rehearsal truth

Repo-local hardening proof and a real environment rehearsal are not the same thing.

- repo-local proof means the workspace checks, release-gate-aligned scripts, and
  config-only rehearsal path all pass
- environment rehearsal means a clean staging window is brought up with real
  runtime values and a report packet is produced under
  `reports/base-sepolia-pilot-validation/<window-id>/`

Do not claim a production-candidate rehearsal from repo-local proof alone.

## What is not finished runtime truth

Do not claim these as complete production truth from this runbook alone:

- full treasury/off-ramp backlog completion
- external banking/off-ramp partner readiness beyond the implemented treasury external-handoff and evidence capture surfaces
- final Base mainnet launch approval
- external deployment platform setup outside this repo

Those are separate workstreams or external dependencies.

## Related runbooks

- `docs/runbooks/docker-profiles.md`
- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/service-auth-matrix.md`
- `docs/runbooks/postgres-service-roles-and-rls.md`
- `docs/runbooks/secrets-and-token-rotation.md`
