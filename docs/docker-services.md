# Docker Service Profiles Runbook

This runbook covers containerized orchestration for these services:
- `oracle`
- `ricardian`
- `treasury`
- `reconciliation`
- indexer services used by each profile

`notifications` remains a library workspace (`@agroasys/notifications`), not a standalone runtime container.
Notification runtime wiring is validated via:
- `scripts/notifications-wiring-health.sh`
- `scripts/notifications-gate.sh`

## Profiles

### `local-dev`
Fast feedback mode with a lightweight in-memory indexer GraphQL responder.

### `staging-e2e`
Existing staging profile.

### `staging-e2e-real`
Staging-grade release-gate profile with real indexer pipeline components:
- `indexer-migrate`
- `indexer-pipeline`
- `indexer-graphql`

## Prerequisites
- Docker Engine with Compose plugin (`docker compose`)
- Root env files created from examples
- Reachable `RPC_URL` if reconciliation/oracle on-chain checks are enabled

## Environment Setup

```bash
cp .env.example .env
cp .env.local.example .env.local
cp .env.staging-e2e.example .env.staging-e2e
cp .env.staging-e2e-real.example .env.staging-e2e-real
```

## Local Dev

```bash
scripts/docker-services.sh build local-dev
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev
scripts/notifications-gate.sh local-dev
scripts/docker-services.sh logs local-dev reconciliation
scripts/docker-services.sh down local-dev
```

## Staging E2E Real

```bash
scripts/docker-services.sh build staging-e2e-real
scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
scripts/notifications-gate.sh staging-e2e-real
scripts/docker-services.sh logs staging-e2e-real reconciliation
scripts/docker-services.sh logs staging-e2e-real indexer-pipeline
scripts/docker-services.sh down staging-e2e-real
```

## Health Endpoints

- Ricardian: `http://127.0.0.1:${RICARDIAN_PORT:-3100}/api/ricardian/v1/health`
- Treasury: `http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health`
- Oracle: `http://127.0.0.1:${ORACLE_PORT:-3001}/api/oracle/health`
- Reconciliation: `node reconciliation/dist/healthcheck.js` (inside container)

`scripts/docker-services.sh health <profile>` waits for required services to become healthy (bounded timeout), then runs endpoint checks. Tune with:
- `DOCKER_SERVICES_WAIT_TIMEOUT_SECONDS` (default `120`)
- `DOCKER_SERVICES_WAIT_POLL_SECONDS` (default `2`)
- `DOCKER_SERVICES_HEALTH_LOG_TAIL_LINES` (default `80`)
- For `local-dev` and `staging-e2e-real`, health also includes notification wiring validation.

## Notes

- Inter-container calls always use service DNS names (for example `indexer`, `indexer-graphql`, `postgres`), never `localhost`.
- Reconciliation startup remains fail-fast when `RPC_URL` is missing/unreachable.
- `staging-e2e-real` gate fails on ENS resolver errors, indexer fetch failures, schema mismatches, and indexer lag threshold breaches.
