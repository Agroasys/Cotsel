# Treasury Settlement Evidence v0

Append-only settlement-evidence and payout-eligibility view for treasury-relevant
events.

This service is not the customer accounting ledger. Agroasys Aurora/Postgres
plus the Agroasys shadow ledger remain canonical for balances, reporting, and
participant-visible funds state.

Canonical boundary:

- [`../docs/contracts/ledger-abstraction-contract.md`](../docs/contracts/ledger-abstraction-contract.md)

## Capabilities

- Ingests `FundsReleasedStage1` and `PlatformFeesPaidStage1` from indexer GraphQL
- Stores append-only settlement-evidence entries
- Stores append-only payout lifecycle state events
- Stores accounting periods, sweep batches, external execution handoff records (`partner_handoffs`, compatibility schema name), and revenue realization records
- Exposes read/query/export endpoints for reconciliation and payout-eligibility review
- Exposes treasury revenue-controls read endpoints for operator/reporting surfaces
- Exposes internal-only mutation endpoints for gateway-owned finance workflow, sweep matching, handoff, and realization evidence
- Blocks payout/export when reconciliation is missing, stale, drifted, or out of scope
- Blocks accounting-period close when tracked sweep-batch trades are not reconciliation-clear
- Exposes reconciliation control-summary metadata for upstream operator surfaces

## Endpoints

Public read/reporting routes:

- `GET /api/treasury/v1/entries`
- `GET /api/treasury/v1/entries/accounting`
- `GET /api/treasury/v1/entries/:entryId/accounting`
- `GET /api/treasury/v1/accounting-periods`
- `GET /api/treasury/v1/sweep-batches`
- `GET /api/treasury/v1/sweep-batches/:batchId`
- `GET /api/treasury/v1/export?format=json|csv`
- `GET /api/treasury/v1/reconciliation/control-summary`
- `GET /api/treasury/v1/health`
- `GET /api/treasury/v1/ready`

Internal mutation routes for gateway/service callers:

- `POST /api/treasury/v1/internal/ingest`
- `POST /api/treasury/v1/internal/entries/:entryId/state`
- `POST /api/treasury/v1/internal/entries/:entryId/realizations`
- `POST /api/treasury/v1/internal/entries/:entryId/bank-confirmation`
- `POST /api/treasury/v1/internal/accounting-periods`
- `POST /api/treasury/v1/internal/accounting-periods/:periodId/request-close`
- `POST /api/treasury/v1/internal/accounting-periods/:periodId/close`
- `POST /api/treasury/v1/internal/sweep-batches`
- `POST /api/treasury/v1/internal/sweep-batches/:batchId/entries`
- `POST /api/treasury/v1/internal/sweep-batches/:batchId/request-approval`
- `POST /api/treasury/v1/internal/sweep-batches/:batchId/approve`
- `POST /api/treasury/v1/internal/sweep-batches/:batchId/match-execution`
- `POST /api/treasury/v1/internal/sweep-batches/:batchId/external-handoff`
- `POST /api/treasury/v1/internal/sweep-batches/:batchId/partner-handoff` (legacy-compatible alias)
- `POST /api/treasury/v1/internal/sweep-batches/:batchId/close`

Health semantics:

- `/health`: process-level liveness
- `/ready`: dependency readiness (database connectivity check)

## Service Auth (optional)

When `AUTH_ENABLED=true`, all API endpoints except `health` and `ready` require HMAC headers:

- `x-agroasys-timestamp` (unix seconds)
- `x-agroasys-signature` (HMAC-SHA256)
- `x-agroasys-nonce` (optional; deterministic fallback derived when omitted)

Protected treasury endpoints:

- `GET /api/treasury/v1/entries`
- `GET /api/treasury/v1/export?format=json|csv`
- `GET /api/treasury/v1/reconciliation/control-summary`
- all `/api/treasury/v1/internal/*` routes

Optional key-based mode:

- `X-Api-Key` to select key-specific secret from `API_KEYS_JSON`
- If `X-Api-Key` is omitted, middleware can verify with `HMAC_SECRET`

Nonce replay store:

- `NONCE_STORE=redis|postgres|inmemory`
- `REDIS_URL` required when `NONCE_STORE=redis`
- `NONCE_TTL_SECONDS` controls nonce replay window (defaults to `AUTH_NONCE_TTL_SECONDS`)
- `NODE_ENV=production` rejects `NONCE_STORE=inmemory` at startup

Canonical string format:
`METHOD\nPATH\nQUERY\nBODY_SHA256\nTIMESTAMP\nNONCE`

Auth failures return structured JSON with stable `code` values (for example: `AUTH_MISSING_HEADERS`, `AUTH_INVALID_SIGNATURE`, `AUTH_FORBIDDEN`).
`API_KEYS_JSON` entries must set `active` as an explicit boolean (`true` or `false`) for each key.

## Observability

Structured logs include baseline keys:

- `service`
- `env`

Correlation keys are emitted by call path when available:

- `tradeId`
- `actionKey`
- `requestId`
- `txHash`

## Revenue Controls

This service now models treasury close as persisted evidence, not spreadsheet-only workflow.

Canonical revenue-controls objects:

- `accounting_periods`
- `sweep_batches`
- `sweep_batch_entries`
- `partner_handoffs`
- `revenue_realizations`

Compatibility note:

- `partner_handoffs` and related `partner_*` fields are retained as stable persistence names
- canonical semantics are external execution handoff evidence against a replaceable counterparty

Visible accounting state is computed from persisted facts:

- `HELD`
- `ALLOCATED_TO_SWEEP`
- `SWEPT`
- `HANDED_OFF`
- `REALIZED`
- `EXCEPTION`

Truth ownership and control semantics are frozen in:

- [`../docs/adr/adr-0412-treasury-revenue-controls-boundary.md`](../docs/adr/adr-0412-treasury-revenue-controls-boundary.md)

Operational close procedure:

- [`../docs/runbooks/treasury-revenue-close.md`](../docs/runbooks/treasury-revenue-close.md)

Authoritative sweep execution evidence is matched from indexed `TreasuryClaimed` events. A batch
does not become `EXECUTED` from operator-supplied amount or destination fields alone.

## Docker

See `docs/docker-services.md` and `docs/runbooks/docker-profiles.md` for runtime operations.

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
