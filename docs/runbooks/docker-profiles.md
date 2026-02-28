# Docker Profiles Runbook

## Purpose
Run deterministic build/start/health/log actions for each supported compose profile.
Production launch criteria are defined in `docs/runbooks/production-readiness-checklist.md`.

## Profiles
- `local-dev`: lightweight mock indexer responder (`indexer`) for fast iteration.
- `staging-e2e`: existing staging profile.
- `staging-e2e-real`: release-gate profile using real indexer pipeline (`indexer-migrate`, `indexer-pipeline`, `indexer-graphql`).
- `infra`: shared infra only (`postgres`, `redis`).

## Preconditions
```bash
cp .env.example .env
cp .env.local.example .env.local
cp .env.staging-e2e.example .env.staging-e2e
cp .env.staging-e2e-real.example .env.staging-e2e-real
```

## Commands
```bash
scripts/docker-services.sh build local-dev
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev
scripts/notifications-gate.sh local-dev

scripts/docker-services.sh build staging-e2e
scripts/docker-services.sh up staging-e2e
scripts/docker-services.sh health staging-e2e

scripts/docker-services.sh build staging-e2e-real
scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
scripts/notifications-gate.sh staging-e2e-real

scripts/docker-services.sh up infra
scripts/docker-services.sh health infra

scripts/docker-services.sh logs staging-e2e-real reconciliation
scripts/docker-services.sh down staging-e2e-real
```

## Expected outputs
- `health <profile>` verifies required services for that profile.
- Non-infra profiles verify indexer GraphQL readiness.
- Reconciliation healthcheck passes when DB is reachable.
- `local-dev` and `staging-e2e-real` include notification wiring checks in `health`.

## Failure modes
- `required service is not running`: profile mismatch or startup failure.
- `indexer graphql endpoint failed`: indexer service not ready.
- `reconciliation healthcheck` failure: DB/auth/config mismatch.
- `notifications wiring health` failure: profile env values are missing/invalid for notification runtime keys.

## Rollback
1. Stop profile:
```bash
scripts/docker-services.sh down <profile>
```
2. Restore last known-good env values.
3. Re-run profile startup and health commands.

## Related
- Production readiness checklist: `docs/runbooks/production-readiness-checklist.md`
