# Notifications Library

Shared notifications module used by Web3 services in this monorepo.

## Delivery Controls

Services use the durable outbox through `createServiceNotifications`:

- `DurableNotifier.notify` commits the alert to the service's `notification_outbox` table before any delivery is attempted, then kicks the dispatcher. `enqueue` can join a caller's transaction and throws when the outbox cannot be written.
- `NotificationDispatcher` leases due rows (`FOR UPDATE SKIP LOCKED`), delivers them, backs off exponentially on failure, dead-letters after the attempt limit, and escalates critical alerts that dead-letter or stay undelivered past the escalation deadline to a separate escalation route.
- A repeat of a pending `dedupKey` is merged into the open row. A repeat within `cooldownMs` of a delivered one is suppressed. Both survive restarts.

`WebhookNotifier` remains the transport. Its `deliver` method makes one attempt and throws `NotificationDeliveryError`. Its older `notify` method keeps the in-memory cooldown and bounded in-process retries, and is now only the fallback for when the outbox cannot be written.

Cooldown is controlled by service env vars:

- `ORACLE_NOTIFICATIONS_COOLDOWN_MS`
- `RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS`
- `INDEXER_NOTIFICATIONS_COOLDOWN_MS`

The escalation route is `*_NOTIFICATIONS_ESCALATION_WEBHOOK_URL`.

## Versioned Routing Metadata

Template and routing metadata are explicitly versioned in the library:

- `NOTIFICATION_ROUTING_VERSION`
- `NOTIFICATION_TEMPLATE_VERSIONS`
- `DEFAULT_TEMPLATE_VERSION`

Severity routes:

- `info` -> `informational`
- `warning` -> `operations`
- `critical` -> `pager`

## Operational Runbook

See `docs/runbooks/notifications.md` for suppression, escalation, and rollback procedures.

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
