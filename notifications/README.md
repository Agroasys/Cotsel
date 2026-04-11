# Notifications Library

Shared notifications module used by Web3 services in this monorepo.

## Delivery Controls

Notifications are deduplicated by `dedupKey` for a cooldown window and can use bounded retries.

- If the same `dedupKey` appears again within the cooldown window, the event is suppressed.
- Cooldown is controlled by service env vars:
  - `ORACLE_NOTIFICATIONS_COOLDOWN_MS`
  - `RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS`
- Retry controls are available in library config:
  - `retryAttempts`
  - `retryDelayMs`
  - `maxRetryDelayMs`

This dedupe is in-memory and process-local; it does not survive process restarts.

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
