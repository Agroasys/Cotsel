# Staging E2E Real Release Gate

## Purpose
Run a staging-grade release gate against the real indexer pipeline profile (`staging-e2e-real`) and validate reconciliation against indexed chain state.
For pilot startup sequencing and go/no-go criteria, use `docs/runbooks/pilot-environment-onboarding.md`.
For participant-facing pilot workflow guidance, use `docs/runbooks/non-custodial-pilot-user-guide.md`.

## Profile differences
- `local-dev`: lightweight in-memory GraphQL responder (`indexer`) for fast iteration.
- `staging-e2e`: existing staging profile.
- `staging-e2e-real`: explicit release-gate profile using real indexer components:
  - `indexer-migrate`
  - `indexer-pipeline`
  - `indexer-graphql`

## Preconditions
- Docker Engine + Compose plugin installed.
- Env files created:
  - `.env`
  - `.env.staging-e2e-real`
- Reconciliation/oracle RPC and indexer endpoints must target the same chain dataset.
- Optional dynamic start-block controls: `STAGING_E2E_REAL_DYNAMIC_START_BLOCK=true` and `STAGING_E2E_REAL_START_BLOCK_BACKOFF=250`.
- Lag gate controls:
  - `STAGING_E2E_MAX_INDEXER_LAG_BLOCKS` (strict default `500`)
  - `STAGING_E2E_REAL_LAG_WARMUP_SECONDS` (default `180`)
  - `STAGING_E2E_REAL_LAG_POLL_SECONDS` (default `5`)

## Commands
```bash
cp .env.example .env
cp .env.staging-e2e-real.example .env.staging-e2e-real

scripts/validate-env.sh staging-e2e-real
scripts/docker-services.sh down staging-e2e-real || true
scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
npm -w notifications run build
scripts/notifications-gate.sh staging-e2e-real
scripts/docker-services.sh logs staging-e2e-real reconciliation
scripts/docker-services.sh logs staging-e2e-real indexer-graphql
scripts/docker-services.sh down staging-e2e-real
```

## CI scope note
The manual `staging-e2e-real` flow above is a staging validation runbook.
GitHub Actions release-gate enforces workspace lint/typecheck/test/build checks and a CI-safe staging gate path (`scripts/validate-env.sh staging-e2e-real` plus `STAGING_E2E_REAL_GATE_ASSERT_CONFIG_ONLY=true scripts/staging-e2e-real-gate.sh`).
CI does not execute the full Docker `up/health/logs/down` staging profile sequence from this runbook.
Source of truth for CI behavior: `.github/workflows/release-gate.yml`.
CI also runs deterministic notification-path verification and uploads `ci-report-notifications-gate`.

## Expected output
- `health staging-e2e-real` reports required services running and healthy.
- `scripts/staging-e2e-real-gate.sh` reports:
  - schema parity result
  - indexer head + lag metrics
  - reorg/resync probe result
  - reconciliation run summary
  - drift classification snapshot
  - warmup-aware lag enforcement (lag threshold enforced after head readiness)
- `scripts/notifications-gate.sh staging-e2e-real` writes `reports/notifications/staging-e2e-real.json` with:
  - delivery + dedup checks for critical oracle/reconciliation event types
  - severity-route/template metadata validation

## Common failure modes
- `STAGING_E2E_REAL_REQUIRE_INDEXED_DATA=true` with empty contract scope: gate fails until a seeded contract/event stream is available.
- `negative lag`: RPC and indexer pipeline are on different networks.
- `indexer head metric unavailable`: `indexer-graphql` not ready or no squid status response.
- `indexer head metric unavailable after warmup`: startup is too slow for configured warmup window; tune `STAGING_E2E_REAL_LAG_WARMUP_SECONDS` only after confirming pipeline is healthy.
- `reconciliation once run failed`: invalid RPC/contract addresses or DB connectivity issue.
- `indexed data requirement enabled but no indexed trades found`: contract/start block scope has no indexed events yet.
- `notifications gate failed`: notifications package was not built (`notifications/dist/index.js` missing) or deterministic critical-path probe checks failed.

## Rollback / backout
1. Stop profile:
```bash
scripts/docker-services.sh down staging-e2e-real
```
2. Revert `.env.staging-e2e-real` to last known-good values.
3. Re-run the command sequence from a clean start.

## Escalation
Escalate if any of the following persists after one clean restart:
- Indexer GraphQL never reaches readiness.
- Lag remains negative.
- Reconciliation fails with repeated critical drift or on-chain read errors.
