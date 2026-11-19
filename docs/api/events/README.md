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
2. **Change a schema by adding the next version.** Add `<name>.v<n+1>.schema.json` and a registry entry with the same `type`. The new version must be backward compatible with the previous one: no removed property, no newly required property, no removed enum value, no removed type, no added `const`, and no closing of `additionalProperties`. A breaking change needs a new event type and a migration plan for consumers.
3. **While a version is being drafted,** mark its entry `"status": "draft"`. Its digest is not enforced yet, but compatibility still is. Remove `draft` and record the digest when you publish it.
4. **Notification types must match the code.** The check reads the `type:` values at every `notify(...)` and `raise(...)` call site in the listed producers. It fails when a type is emitted but not registered, or registered but no longer emitted. To add a type, publish a new `cotsel.notification` version that adds it to the enum.

Run the check with:

```bash
pnpm run events:registry:check
```

The release gate runs the same command. Producers still write their existing outbox rows; emitting the envelope from every outbox is the next slice of #949.
