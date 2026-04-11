# Reconciliation Worker v0

Read-only worker that compares indexed trade state to on-chain trade state and persists drift findings.

## Features

- Read-only reconciliation (no on-chain writes)
- Idempotent run keys
- Drift persistence in Postgres (`reconcile_runs`, `reconcile_drifts`)
- Severity classification (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`)
- CLI entrypoints:
  - `npm run reconcile:once`
  - `npm run reconcile:daemon`

## Run

```bash
cp .env.example .env
npm install
npm run reconcile:once
```

Daemon mode is disabled by default. Set `RECONCILIATION_ENABLED=true` to run continuously.

Reconciliation requires a reachable `RPC_URL` at startup and fails fast with a clear error when the endpoint is unavailable.

## Healthcheck

After building, run:

```bash
npm run healthcheck
```

Reconciliation is a worker process (no HTTP server), so readiness is exposed through process startup + healthcheck command rather than `/ready`.

## Observability

Structured logs include baseline keys:

- `service`
- `env`

Correlation keys are emitted by reconciliation findings when available:

- `tradeId`
- `actionKey`
- `requestId`
- `txHash`

## Docker

See `docs/docker-services.md` and `docs/runbooks/reconciliation.md`.

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
