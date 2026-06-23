# Cotsel CLI (`scripts/cotsel.sh`) Runbook

`scripts/cotsel.sh` is the single entry point for building, running, and
deploying the Cotsel runtime stack. There is one compose profile (`runtime`)
and one env file (`.env.runtime`); the same stack serves local development and
VM deployment, differing only in `.env.runtime` values.

It orchestrates these services: `auth`, `oracle`, `ricardian`, `treasury`,
`reconciliation`, `gateway`, and the split indexer pipeline
(`indexer-migrate`, `indexer-pipeline`, `indexer-graphql`), plus `postgres` and
`redis`.

`notifications` remains a library workspace (`@agroasys/notifications`), not a
standalone runtime container. Notification runtime wiring is validated via:

- `scripts/notifications-wiring-health.sh`
- `scripts/notifications-gate.sh`

## Prerequisites

- Docker Engine with Compose plugin (`docker compose`)
- `.env.runtime` created from `.env.runtime.example` with every value filled in
- Reachable RPC endpoints if reconciliation/oracle on-chain checks are enabled

## Environment Setup

```bash
cp .env.runtime.example .env.runtime   # then fill in every value
```

`scripts/cotsel.sh build|up|health|config` runs `scripts/validate-env.sh`
before Docker Compose. A missing or incomplete `.env.runtime` fails before
containers are built or Compose interpolation renders blank values.

## Commands

```bash
scripts/cotsel.sh build [service]    # build images (all, or one service)
scripts/cotsel.sh up                 # validate env + start the stack
scripts/cotsel.sh up --gate          # full validated deploy + release gate (VM)
scripts/cotsel.sh up --gate --skip-build   # config-only re-deploy with current images
scripts/cotsel.sh health             # wait for + probe service health
scripts/cotsel.sh logs [service]     # tail logs
scripts/cotsel.sh ps
scripts/cotsel.sh config             # render resolved compose config
scripts/cotsel.sh down               # stop + remove (with volumes)
```

## Health Endpoints

- Auth: `http://127.0.0.1:${AUTH_PORT:-3005}/api/auth/v1/health`
- Ricardian: `http://127.0.0.1:${RICARDIAN_PORT:-3100}/api/ricardian/v1/health`
- Treasury: `http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health`
- Gateway: `http://127.0.0.1:${GATEWAY_PORT:-3600}/api/dashboard-gateway/v1/healthz`
- Oracle: `http://127.0.0.1:${ORACLE_PORT:-3001}/api/oracle/health`
- Reconciliation: `node reconciliation/dist/healthcheck.js` (inside container)

`scripts/cotsel.sh health` waits for required services to become healthy
(bounded timeout), then runs endpoint checks and notification wiring
validation. Tune with:

- `DOCKER_SERVICES_WAIT_TIMEOUT_SECONDS` (default `120`)
- `DOCKER_SERVICES_WAIT_POLL_SECONDS` (default `2`)
- `DOCKER_SERVICES_HEALTH_LOG_TAIL_LINES` (default `80`)

## Notes

- Inter-container calls always use service DNS names (for example `indexer-graphql`, `postgres`), never `localhost`.
- Reconciliation startup is fail-fast when its RPC endpoint is missing/unreachable.
- The release gate (`scripts/cotsel.sh up --gate`) fails on ENS resolver errors, indexer fetch failures, schema mismatches, and indexer lag threshold breaches. See `docs/runbooks/runtime-release-gate.md`.

## Related

- Runtime stack runbook: `docs/runbooks/runtime-stack.md`
- Runtime release gate: `docs/runbooks/runtime-release-gate.md`
- VM deployment: `docs/runbooks/vm-deploy.md`
