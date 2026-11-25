# Notifications runbook

## Purpose

Use this runbook to operate durable alert delivery (SOW H-26). For durable
delivery, producers write alerts to a Postgres outbox before sending them. The
dispatcher retries delivery with bounded backoff. When an alert reaches its
attempt limit, the dispatcher moves it to dead letter. If a critical alert
cannot be delivered, the dispatcher escalates it to the duty owner.

## Source of truth

Use these source files and tables:

- Notification library: `notifications/src/index.ts`
  - Durable outbox queries: `notifications/src/outbox.ts`
  - Dispatcher (retry, dead letter, escalation): `notifications/src/dispatcher.ts`
  - Producer API: `notifications/src/durableNotifier.ts`
- Outbox table `notification_outbox`, one per service database:
  - `oracle/src/database/schema/005_notification_outbox.sql`
  - `reconciliation/src/database/005_notification_outbox.sql`
  - `indexer/db/migrations/1785700000000-NotificationOutbox.js`
- Runtime integrations:
  - `oracle/src/server.ts` (wiring), `oracle/src/core/trigger-manager.ts`, `oracle/src/worker/confirmation-worker.ts`
  - `reconciliation/src/core/notifications.ts` (wiring), `reconciliation/src/core/alertDispatch.ts`
  - `indexer/src/main.ts` (wiring), `indexer/src/alerts.ts`
- Runtime/profile gates:
  - `scripts/notifications-wiring-health.sh`
  - `scripts/notifications-gate.sh`
  - `scripts/notifications-gate-validate.mjs`

## Template and severity versioning

- Routing version constant: `NOTIFICATION_ROUTING_VERSION`
- Template version registry: `NOTIFICATION_TEMPLATE_VERSIONS`
- Fallback template version: `DEFAULT_TEMPLATE_VERSION`

Versioning strategy:

1. Add a new template version key instead of mutating existing version identifiers.
2. Update producer event `type` mapping only after template rollout is ready.
3. Keep prior version entry during rollout window to support safe rollback.

Severity route policy:

- `info` -> `informational`
- `warning` -> `operations`
- `critical` -> `pager`

For all registered producer types, see the [event schema registry](../api/events/registry.json).
These are common notification and escalation types.

| `type`                                   | Source         | Severity | Meaning                                                                                                                                  |
| ---------------------------------------- | -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ORACLE_TRIGGER_TERMINAL_FAILURE`        | oracle         | critical | Settlement trigger failed terminally.                                                                                                    |
| `ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE` | oracle         | critical | Trigger retries exhausted; needs redrive.                                                                                                |
| `ORACLE_CONFIRMATION_TIMEOUT`            | oracle         | warning  | Broadcast confirmation timed out.                                                                                                        |
| `RECONCILIATION_CRITICAL_DRIFT`          | reconciliation | critical | On-chain and indexed trade state disagree.                                                                                               |
| `INDEXER_POISON_LOG`                     | indexer        | critical | An escrow log could not be projected; the indexer quarantined it and is holding its checkpoint. Follow `indexer-poison-log-recovery.md`. |
| `RECONCILIATION_COVERAGE_GAP`            | reconciliation | critical | A chain trade is absent from the indexer projection, or the indexer holds more trades than the chain allocated ids.                      |
| `RECONCILIATION_COVERAGE_BACKLOG`        | reconciliation | critical | The uncovered trade tail breached its age SLA.                                                                                           |
| `NOTIFICATION_ESCALATION`                | any            | critical | Sent to the escalation route: a critical alert dead-lettered or stayed undelivered past the escalation deadline.                         |

## Delivery lifecycle

The delivery lifecycle has these phases:

- **Enqueue:** A producer calls `notify` or `enqueue`. It writes a `PENDING` row before it attempts a webhook delivery. `enqueue` can use the caller's transaction. The alert then commits or rolls back with the state it describes.
- **Lease:** Immediately before delivery, the dispatcher leases one due row with `FOR UPDATE SKIP LOCKED`. Critical rows have priority. Replicas cannot send the same leased row at the same time. A queued backlog cannot outlive a lease acquired only at delivery time. A lease lasts at least 60 seconds and four times the webhook timeout. A pass attempts each row at most once. The service counts the attempt when it claims the row. A worker failure during delivery therefore consumes an attempt.
- **Delivery result:** Successful delivery sets `DELIVERED`. Failure records `last_error`. Retries use exponential backoff with a five-second base and a five-minute maximum.
- **Attempt limit:** After eight attempts, the row becomes `DEAD_LETTER`. If the final attempt reports no result, the dispatcher waits until its lease expires before recording that state.
- **Escalation:** A critical row escalates when it becomes a dead letter. It also escalates if it remains undelivered ten minutes after it was first raised. Primary delivery continues its remaining retries while the overdue row escalates.

Delivery is at least once. If a worker fails after webhook acceptance but before recording completion, the service sends the alert again. A duplicate page is the safe failure.

Each long-running process dispatches every 15 seconds. It also dispatches after each `notify` call, so a new alert need not wait for the timer. Reconciliation `once` dispatches at the end of the run.

Deduplication and cooldown use these rules:

- If an alert's `dedupKey` is still `PENDING`, a repeat increments `occurrences` on that row. It creates no second page.
- Within `cooldownMs`, a repeat of a `DELIVERED` row's `dedupKey` is suppressed. The database stores the cooldown, which survives restarts.

These conditions affect delivery:

- **Webhook outage or process restart:** the row stays `PENDING`. The next dispatcher delivers it after the route recovers.
- **Outbox write failure:** if `notify` cannot store a registered alert, it logs the error and attempts direct webhook delivery. Reconciliation run-outbox alerts use `enqueue`, which throws if the write fails. The `reconcile_alert_outbox` row stays pending for the next run.
- **Notifications disabled:** with `*_NOTIFICATIONS_ENABLED=false`, the service queues no new alerts and sends no backlog or escalation. Queued rows retain their attempt counts. Delivery resumes when notifications are enabled. The first pass logs `Notifications are disabled; queued notifications are retained unsent` with the counts.
- **Escalation route missing:** the service retains undeliverable critical alerts. Each dispatch pass logs `Critical notifications need escalation but no escalation route is configured` at error level with the count.

## Escalation route

Each service reads `NOTIFICATIONS_ESCALATION_WEBHOOK_URL` (runtime profile: `ORACLE_`, `RECONCILIATION_`, `INDEXER_NOTIFICATIONS_ESCALATION_WEBHOOK_URL`). Use the duty owner's paging integration. Use a different provider or integration from `NOTIFICATIONS_WEBHOOK_URL`. An outage of the primary route must not disable escalation. Treat it as a secret.

The escalation page (`NOTIFICATION_ESCALATION`) renders only the following fields in the webhook body:

- original type and message
- correlation and `dedupKey`
- attempt and occurrence counts
- sanitized last error
- outbox ID and first-raised time

Only this allowlist is rendered. Other metadata, including the original alert's, never reaches the webhook. Stored and forwarded errors never contain URLs.

## Inspect the outbox

Readiness reports `notificationOutbox` counts on reconciliation `/ready`. For any service, connect as the service's runtime role:

```sql
SELECT state, severity, COUNT(*), MIN(created_at) AS oldest
FROM notification_outbox
WHERE state <> 'DELIVERED'
GROUP BY state, severity;

SELECT id, event_type, dedup_key, attempts, occurrences, last_error,
       escalation_reason, escalated_at, escalation_last_error
FROM notification_outbox
WHERE state = 'DEAD_LETTER' OR (severity = 'critical' AND escalated_at IS NULL AND state = 'PENDING')
ORDER BY id;
```

## Redrive a dead letter

`DELIVERED` and `DEAD_LETTER` rows are immutable evidence: a trigger rejects any change to their state, payload or attempt count. Triggers reject deletion or truncation of every row, regardless of state or role, including the owner. The runtime role has no `DELETE` grant. The indexer migration revokes the grant assigned by its default privileges. To redrive a dead letter after the route is fixed, insert a new row that names it:

```sql
INSERT INTO notification_outbox (source, event_type, severity, dedup_key, event, redriven_from)
SELECT source, event_type, severity, dedup_key, event, id
FROM notification_outbox
WHERE id = :dead_letter_id AND state = 'DEAD_LETTER';
```

Record the redrive in the incident timeline. Never redrive a row you have not confirmed is still unanswered.

## Suppression procedure

Use this procedure to check whether the producer suppresses duplicate
notifications. Do not disable critical notifications globally.

1. Confirm that duplicate events share the same `dedupKey`.
2. Verify that the cooldown window (`cooldownMs`) is appropriate for the event type.
3. If duplicate notifications persist, adjust how the producer sets `dedupKey`.
4. Run the smoke notification again.
5. Confirm suppression in the logs.

## Escalation procedure

Automatic escalation is described under [Escalation route](#escalation-route). Human escalation by severity route:

- `informational`: ticket or async backlog follow-up.
- `operations`: on-call operations channel with 30-minute response target.
- `pager`: immediate paging and incident process start.

Capture evidence when escalating:

- event `type`, `severity`, `dedupKey`, outbox `id`
- attempt count, `last_error`, and escalation state from `notification_outbox`
- correlation fields (`tradeId`, `actionKey`, `requestId`, `txHash`, `runKey`)

## Rollback procedure

After an outbox migration, an older service image can fail the immutable
migration check even if the schema change is additive. A package-only revert
requires both a reviewed compatibility build and a delivery rehearsal.

Do not edit the migration ledger.

Use this procedure to recover the producer and verify delivery.

1. If the affected producer cannot publish valid events, stop it.
2. Preserve the producer's outbox and delivery evidence.
3. Use a forward fix that retains all applied migrations.
4. Restore the previous template version mapping in `NOTIFICATION_TEMPLATE_VERSIONS`.
5. Run the notifications tests with `pnpm --filter ./notifications run test --if-present`.
6. Build the notifications package with `pnpm --filter ./notifications run build`.
7. Run the deterministic gate probe with `scripts/notifications-gate.sh runtime`.
8. Confirm that logs contain no secrets.
9. Confirm that the dispatcher still enforces retry limits.

## Runtime health and release evidence

- Profile-level wiring health checks:
  - `scripts/cotsel.sh health`
- Deterministic critical-path probe:
  - `scripts/notifications-gate.sh runtime`
  - Report output: `reports/notifications/runtime.json`
- CI evidence artifact:
  - `ci-report-notifications-gate` from `.github/workflows/release-gate.yml`
  - Contains deterministic probe output for:
    - `ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE`
    - `RECONCILIATION_CRITICAL_DRIFT`

## Safety requirements

- Do not log webhook secrets, tokens, or full credentialed URLs.
- Keep retry attempts bounded.
- Keep dedup key stable and deterministic per event identity.
- Do not delete or rewrite settled `notification_outbox` rows; redrive dead letters as new rows.

## Verification commands

```bash
pnpm --filter ./notifications run test --if-present
pnpm --filter ./notifications run lint
pnpm --filter ./notifications run build
scripts/notifications-gate.sh runtime
```

## Refused event types

If the notification type is unregistered, the producer refuses the
notification before durable enqueue. The direct-delivery fallback is
unavailable for this refusal. An operator notification can remain unsent.

Do not log secrets or raw credentials. Do not bypass the outbox. Do not invent a
replacement event type to suppress the error.

Use this procedure to recover a refused notification.

1. Preserve the producer error, event type, dedup key, and correlation identifiers.
2. Check the event against the [event schema registry](../api/events/registry.json)
   and its frozen schema.
3. Prepare the producer correction.
4. Run `pnpm run events:registry:check`.
5. Run the producer's outbox tests.
6. Submit the producer correction for review with any compatible registry addition.
7. Deploy the reviewed forward fix.
8. Repeat or redrive the source operation through its supported idempotent path.
9. Verify the outbox row.
10. Verify the delivery state.
