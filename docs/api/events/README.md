# Cotsel event schema registry

Audience: engineers who add or change an event that Cotsel publishes. Scope: `docs/api/events/` and the check that guards it (#949).

`registry.json` lists every published event schema:

| Entry                           | Schema                                                                            | Notes                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope v1                     | `envelope.v1.schema.json`                                                         | Wraps every published event: `eventId`, `type`, `schemaVersion`, `producer`, `settlementId`, `orderingKey`, `occurredAt`, `payload`. Consumers deduplicate on `eventId` and order by `orderingKey`. |
| `cotsel.notification` v1        | `notification-event.v1.schema.json`                                               | The operational `NotificationEvent` raised by oracle, reconciliation and indexer and held in `notification_outbox`. Its `type` enum lists every notification type.                                  |
| `cotsel.settlement-callback.v1` | `CotselSettlementCallbackV1` in `docs/api/cotsel-settlement-provider.openapi.yml` | The settlement callback consumed by the Agroasys backend. The OpenAPI document stays the source of truth; the registry freezes it.                                                                  |

## Rules

1. **Published versions are frozen.** Each entry records the SHA-256 of its schema; for the callback contract, the SHA-256 of the YAML text of the schema and every schema it references. Any edit to a published schema fails the check.
2. **Change a schema by adding the next version.** Add `<name>.v<n+1>.schema.json` and a registry entry with the same `type`. The guarantee is compatibility with existing consumers: every value the new producer may emit must be accepted by the previous schema. The check rejects added enum values or types, removed required fields, new properties on closed objects, and removed constraints. Requiring a previously optional field, narrowing an enum or type, and closing additional properties are compatible. Changed existing bounds are rejected conservatively, even if they might narrow output. A breaking change needs a new event type and a consumer migration plan. This guarantee does not establish that new consumers can replay historical events; consumers that need replay must accept the retained versions explicitly.
3. **While a version is being drafted,** mark its entry `"status": "draft"`. Its digest is not enforced yet, but compatibility still is. Remove `draft` and record the digest when you publish it.
4. **Every emitted notification type must be registered.** The check reads the `type:` values at every `notify(...)` and `raise(...)` call site in the listed producers. Emitted types outside the latest registered schema fail the check. Published schemas may retain types no longer emitted, so a producer can retire a type without rewriting history. Adding an enum value breaks existing strict consumers; use a new event type and migrate those consumers before emitting it.

Run the check with:

```bash
pnpm run events:registry:check
```

The release gate runs the same command.

## Where the envelope is written

`@agroasys/notifications` (`NotificationOutbox.enqueue`) stores the envelope in `notification_outbox.envelope` for every notification that oracle, reconciliation and indexer raise. It is built by `buildNotificationEnvelope` in `notifications/src/envelope.ts`:

- **Field values:** `eventId` is a fresh UUID; `producer` is the event `source`; `settlementId` is `correlation.tradeId`, or `null`; `orderingKey` is the dedup key; and `payload` is the notification.
- **Repeats:** a merged repeat of the same incident keeps the first envelope, so `eventId` is stable while `occurrences` counts the repeats. The `event` column holds the latest occurrence.
- **Integrity:** the column is constrained to the envelope shape, and a trigger makes a written envelope immutable. Rows written before the migration have a `NULL` envelope.
- **Migrations:** oracle `202611230001`, reconciliation `202611230001`, indexer `1785800000000`.
- **Type list:** `notifications/src/envelope.ts` keeps its own `REGISTERED_NOTIFICATION_TYPES`, and the check fails if it differs from the registry. `buildNotificationEnvelope` throws `UnregisteredNotificationTypeError` for any other type, and the registry check scans every `notify`, `raise` and `enqueue` call site, so an unregistered type fails in CI before it can reach a producer.

Relays and consumers (#957, #958) read `envelope`, deduplicate on `eventId`, and order by `orderingKey`.
