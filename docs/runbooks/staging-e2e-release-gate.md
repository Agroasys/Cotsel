# Staging E2E Release Gate Runbook

## Purpose

Run deterministic staging checks before merge/release.

For staging-grade validation with the explicit real indexer profile, use `docs/runbooks/staging-e2e-real-release-gate.md`.
For Base mainnet launch approval and ordered production rollback, use:

- `docs/runbooks/base-mainnet-go-no-go.md`
- `docs/runbooks/base-mainnet-cutover-and-rollback.md`

## Preconditions

- `.env` and `.env.staging-e2e` populated.
- Contract/indexer addresses target the same chain.

## Commands

```bash
scripts/docker-services.sh down staging-e2e
scripts/docker-services.sh up staging-e2e
scripts/docker-services.sh health staging-e2e
scripts/validate-env.sh staging-e2e
scripts/docker-services.sh logs staging-e2e reconciliation
scripts/docker-services.sh logs staging-e2e indexer-graphql
scripts/staging-e2e-gate.sh
```

## Expected outputs

- All required staging services running (`postgres`, `redis`, `indexer-pipeline`, `indexer-graphql`, `oracle`, `reconciliation`, `ricardian`, `treasury`).
- Health checks pass for service endpoints and indexer GraphQL.
- Reconciliation logs have no ENS resolution errors and no recurring indexer fetch failures.

## Common failure patterns

- `indexer graphql endpoint failed`: indexer pipeline not synced or DB auth mismatch.
- `RPC endpoint is unreachable`: reconciliation/oracle RPC URL mismatch.
- Negative lag or chain mismatch symptoms between RPC and indexer datasets.

## First 15 Minutes Checklist

- Execute `docs/incidents/first-15-minutes-checklist.md`.
- Run health checks and capture reconciliation + indexer logs.
- Record indexer head lag and drift summary before deciding rollback.

## Rollback / backout

1. Stop staging profile.
2. Revert env override to last known-good values.
3. Re-run gate from clean start (`down` then `up`).

## Escalation criteria

- Reconciliation cannot stay healthy for 10+ minutes.
- Drift spikes with repeated CRITICAL mismatches.
- Indexer pipeline cannot advance head height.

Boundary note:

- This runbook is a staging validation surface only.
- It is not sufficient by itself for M5 production approval.
