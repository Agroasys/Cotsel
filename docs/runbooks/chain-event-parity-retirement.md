# Chain Event Parity And Legacy Ingest Retirement

## Purpose and scope

Document the authoritative replacement for the legacy `platform.v1/supabase/functions/chain-events/index.ts` webhook ingest and define when that Supabase path can be retired safely.

This runbook covers:

- legacy webhook responsibilities
- the current Cotsel component that replaces each responsibility
- responsibilities intentionally retired rather than reimplemented
- the operator verification steps required before declaring the legacy ingest obsolete

## Legacy ingest summary

The legacy Supabase function accepted webhook payloads from an indexer, verified an HMAC signature, suppressed duplicates using `chain_events_log`, and projected protocol events into application tables such as `orders`, `settlements`, `escrow`, `payments`, `disputes`, and `notifications`.

Legacy events handled there included:

- `TradeCreated`
- `TradeSigned`
- `TradeLocked`
- `DeliveryConfirmed`
- `FundsReleased`
- `TradeDisputed`

That function mixed two concerns:

- authoritative protocol-event intake
- application-side projections and notifications for the old platform database

## Authoritative replacement matrix

| Legacy responsibility                          | Legacy implementation                                        | Current authoritative replacement                                                                                                                                                                                           | Evidence path                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Receive chain events from an upstream webhook  | Supabase edge function POST handler                          | `indexer/src/main.ts` reads finalized chain events directly from the processor; no webhook transport is required for protocol truth                                                                                         | `indexer/README.md`, `indexer/src/main.ts`                                                                                            |
| Verify event authenticity in transit           | HMAC on `x-webhook-signature`                                | Not needed for protocol ingest because Cotsel indexer reads the chain directly. Service-to-service HMAC remains only for explicit HTTP mutation/read boundaries such as treasury/oracle, not for authoritative chain ingest | `oracle/tests/authenticated-routes.test.ts`, `treasury/tests/serviceAuthRoutes.test.ts`                                               |
| Suppress duplicate event application           | `chain_events_log` duplicate lookup by event type/hash/index | Deterministic event entity IDs and append-only indexer persistence; downstream consumers read from the indexed store rather than replaying webhook bodies                                                                   | `indexer/src/model/generated/tradeEvent.model.ts`, `indexer/src/model/generated/systemEvent.model.ts`                                 |
| Maintain canonical trade state                 | Supabase updates to `orders` and `settlements`               | `Trade` plus `TradeEvent` records in the indexer, with gateway trade reads exposing the operator-facing projection                                                                                                          | `indexer/src/model/generated/trade.model.ts`, `gateway/src/core/tradeReadService.ts`, `docs/api/cotsel-dashboard-gateway.openapi.yml` |
| Maintain event timeline for audits             | `chain_events_log` rows                                      | Indexed trade/system events plus gateway trade timeline rendering                                                                                                                                                           | `gateway/src/core/tradeReadService.ts`, `GET /trades/{tradeId}` in `docs/api/cotsel-dashboard-gateway.openapi.yml`                    |
| Track lifecycle freshness and operator summary | Implicit via webhook processing timestamps                   | `OverviewSnapshot` in the indexer plus gateway overview/operations summaries                                                                                                                                                | `indexer/src/model/generated/overviewSnapshot.model.ts`, `gateway/src/core/overviewService.ts`, `GET /operations/summary`             |
| Detect truth-source conflicts                  | Ad hoc platform-side investigation                           | Reconciliation compares indexed state to on-chain state and persists deterministic drifts and reports                                                                                                                       | `reconciliation/src/indexer/client.ts`, `reconciliation/src/core/reconciler.ts`, `docs/runbooks/reconciliation.md`                    |
| Treasury release / fee accounting              | Payment and settlement side effects in Supabase tables       | Treasury ingests treasury-relevant indexed events and exposes append-only accounting views; reconciliation consumes the resulting evidence                                                                                  | `treasury/README.md`, `treasury/src/core/ingestion.ts`, `docs/runbooks/reconciliation.md`                                             |
| Notifications on drift or settlement anomalies | Supabase notifications inserts                               | Notifications are no longer a chain-ingest side effect. Cotsel sends operator notifications from current services such as reconciliation, using protocol-authoritative data as input                                        | `notifications/README.md`, `reconciliation/src/core/reconciler.ts`                                                                    |

## Responsibilities intentionally retired

The following legacy behaviors are not authoritative protocol-ingest responsibilities in Cotsel and are intentionally retired rather than recreated in the indexer:

- mutating platform.v1 `orders`, `settlements`, `escrow`, and `payments` tables
- storing orphaned application events when a Ricardian/order row is missing in a separate product database
- emitting product-facing notifications directly from the ingest function

Interpretation:

- Cotsel now owns protocol truth, event history, treasury accounting inputs, reconciliation, and operator read surfaces
- application-specific projections must consume Cotsel read models instead of expecting a chain-event webhook to mutate their private tables

## Retirement checklist

Retire the legacy Supabase `chain-events` function only when all of the following are true:

1. Operators can retrieve canonical trade lifecycle and timeline data from the indexer or gateway trade read endpoints.
2. Treasury accounting consumers use `treasury/` exports or reconciliation artifacts, not Supabase `payments` side effects.
3. Drift review uses reconciliation outputs (`reconcile_runs`, `reconcile_drifts`, report JSON), not manual comparison against legacy shadow-ledger rows.
4. No release gate, operator runbook, or dashboard flow still depends on `platform.v1` `orders`/`settlements`/`escrow` status columns as the primary truth source.
5. Any remaining product notification flows are triggered from current Cotsel services or have been deliberately decommissioned.

## Operator verification procedure

Before marking the legacy ingest retired:

1. Query a representative trade from the gateway `GET /trades/{tradeId}` surface and confirm lifecycle timeline + tx references are present.
2. Confirm indexer freshness via the overview snapshot and record `lastProcessedBlock` / `lastIndexedAt`.
3. Run `npm run -w reconciliation reconcile:report -- --run-key=<runKey> --out reports/reconciliation/latest.json` and archive the report.
4. Confirm treasury entries for a released trade are present via `GET /api/treasury/v1/entries` or treasury export.
5. Record the retirement evidence bundle in the incident/operator audit template if this change is coupled to an environment cutover.

## References

- `docs/runbooks/reconciliation.md`
- `docs/api/cotsel-dashboard-gateway.openapi.yml`
- `docs/runbooks/operator-audit-evidence-template.md`
- `docs/incidents/incident-evidence-template.md`
