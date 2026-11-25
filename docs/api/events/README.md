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
4. **Every emitted notification type must be registered.** The check reads the `type:` values at `notify(...)`, `raise(...)`, and `enqueue(...)` call sites in the listed producers. Emitted types outside the latest registered schema fail the check. Published schemas may retain types no longer emitted, so a producer can retire a type without rewriting history. Adding an enum value breaks existing strict consumers; use a new event type and migrate those consumers before emitting it.

Run the check with:

```bash
pnpm run events:registry:check
```

The release gate runs the same command.

## Notification envelopes

`NotificationOutbox.enqueue` in `@agroasys/notifications` stores the envelope in
`notification_outbox.envelope` for notifications from oracle, reconciliation,
and indexer. The [notification envelope builder](../../../notifications/src/envelope.ts)
(`buildNotificationEnvelope`) sets these fields.

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| `eventId`      | A new universally unique identifier (UUID) |
| `producer`     | The event's `source`                       |
| `settlementId` | `correlation.tradeId`, or `null`           |
| `orderingKey`  | The event's deduplication key              |
| `payload`      | The notification                           |

When the outbox merges a repeat of an incident into an existing row, it keeps
the first envelope and its `eventId`. The outbox increments `occurrences` and
stores the latest occurrence in `event`.

A database constraint checks the envelope shape. A trigger rejects changes to
a stored envelope. Rows written before the migration have a `NULL` envelope.
The migration IDs are `202611230001` for oracle, `202611230001` for
reconciliation, and `1785800000000` for indexer.

`buildNotificationEnvelope` throws `UnregisteredNotificationTypeError` when a
type is absent from `REGISTERED_NOTIFICATION_TYPES`. In continuous integration
(CI), the registry check compares that list with the registry. It also checks
`notify`, `raise`, and `enqueue` call sites in the listed producers for
unregistered types.

The planned relays and consumers (#957, #958) must read `envelope`, deduplicate
on `eventId`, and order by `orderingKey`. This producer change does not implement
those consumers.

## Settlement callback envelopes

The gateway stores callback envelopes in
`settlement_callback_deliveries.envelope` through migration `202611240019`.
The registered type is `cotsel.settlement-callback`, version `v1`, with producer
`gateway`. The envelope uses the callback event identifier as `eventId` and the
trade identifier as `orderingKey`.

The payload follows the frozen `cotsel.settlement-callback.v1` contract. HTTP
delivery and signatures use the existing request body. Retries preserve the
stored envelope. A database trigger rejects changes after publication.
Historical rows and writers that omit the additive column can leave it `NULL`.
