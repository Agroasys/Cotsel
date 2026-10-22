# Notifications Runbook

## Purpose

Operate durable alert delivery: every alert is committed to a Postgres outbox before delivery, retried with bounded backoff, dead-lettered when its attempts are spent, and escalated to the duty owner when a critical alert cannot be delivered (SOW H-26).

## Source Of Truth

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

## Template And Severity Versioning

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

Registered producer event types:

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

## Delivery Lifecycle

1. A producer calls `notify` (or `enqueue`). The alert is written to `notification_outbox` as `PENDING` before any webhook is tried. `enqueue` can join the caller's transaction so an alert commits or rolls back with the state it describes.
2. The dispatcher leases one due row at a time (`FOR UPDATE SKIP LOCKED`, critical first), immediately before sending it, so several replicas never send the same row at once and a slow backlog cannot outlive its leases. The lease is at least 60 s and at least four times the webhook timeout. A pass attempts each row at most once. The attempt is counted at claim time, so a worker that dies mid-delivery still spends an attempt.
3. Success marks the row `DELIVERED`. Failure records `last_error` and backs off exponentially (5 s base, 5 min cap).
4. After 8 attempts the row becomes `DEAD_LETTER`. A row whose final attempt never reported back is dead-lettered once its lease expires.
5. A critical row escalates to the escalation route when it dead-letters, or when it is still undelivered 10 minutes after it was first raised. Primary delivery keeps retrying while an overdue row is escalated.

Delivery is at-least-once: a crash after the webhook accepted an alert, but before the row was settled, sends it again. A duplicate page is the safe failure.

Dispatch runs on a 15 s timer in each long-running process and is also kicked straight after every `notify`, so a new alert does not wait for the timer. Reconciliation `once` runs dispatch at the end of the run.

Dedup and cooldown:

- A repeat of an alert whose `dedupKey` is still `PENDING` is merged into that row (`occurrences` + 1) instead of queueing a second page.
- A repeat within `cooldownMs` of a `DELIVERED` row with the same `dedupKey` is suppressed. The cooldown is read from the database, so it survives restarts.

Failure modes:

- **Webhook outage or process restart:** the row stays `PENDING` and is delivered when the route recovers, by whichever process drains next.
- **Outbox write fails (database unavailable):** `notify` logs an error and falls back to one direct best-effort webhook send. Reconciliation run-outbox alerts use `enqueue` instead, which throws, so the `reconcile_alert_outbox` row stays pending and is retried on the next run.
- **Notifications disabled (`*_NOTIFICATIONS_ENABLED=false`):** nothing new is queued and the dispatcher sends nothing, including existing backlog and escalations. Queued rows keep their attempt counts and are delivered once notifications are re-enabled. The first pass logs `Notifications are disabled; queued notifications are retained unsent` with the counts.
- **No escalation route configured:** undeliverable critical alerts are still kept, and every dispatch pass logs `Critical notifications need escalation but no escalation route is configured` at error level with the count.

## Escalation Route

Each service reads `NOTIFICATIONS_ESCALATION_WEBHOOK_URL` (runtime profile: `ORACLE_`, `RECONCILIATION_`, `INDEXER_NOTIFICATIONS_ESCALATION_WEBHOOK_URL`). Point it at the duty owner's paging integration, on a different provider or integration from `NOTIFICATIONS_WEBHOOK_URL`, so an outage of the primary route cannot also take out escalation. Treat it as a secret.

The escalation page (`NOTIFICATION_ESCALATION`) renders the original type, message, correlation, `dedupKey`, attempt count, occurrence count, sanitized last error, the outbox id and first-raised time into the webhook body. Only this allowlist is rendered: other metadata, including the original alert's, never reaches the webhook. Stored and forwarded errors never contain URLs.

## Inspecting The Outbox

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

## Dead-Letter Redrive

`DELIVERED` and `DEAD_LETTER` rows are immutable evidence: a trigger rejects any change to their state, payload or attempt count. No row of any state can be deleted or truncated: triggers reject it for every role, including the owner, and the runtime role has no `DELETE` grant (the indexer migration revokes the one its default privileges hand out). To redrive a dead letter after the route is fixed, insert a new row that names it:

```sql
INSERT INTO notification_outbox (source, event_type, severity, dedup_key, event, redriven_from)
SELECT source, event_type, severity, dedup_key, event, id
FROM notification_outbox
WHERE id = :dead_letter_id AND state = 'DEAD_LETTER';
```

Record the redrive in the incident timeline. Never redrive a row you have not confirmed is still unanswered.

## Suppression Procedure

1. Confirm duplicate events share the same `dedupKey`.
2. Verify cooldown window (`cooldownMs`) is appropriate for the event type.
3. If noise persists, adjust event producer key strategy (do not disable critical notifications globally).
4. Re-run smoke notification and confirm suppression in logs.

## Escalation Procedure

Automatic escalation is described under [Escalation Route](#escalation-route). Human escalation by severity route:

- `informational`: ticket or async backlog follow-up.
- `operations`: on-call operations channel with 30-minute response target.
- `pager`: immediate paging and incident process start.

Capture evidence when escalating:

- event `type`, `severity`, `dedupKey`, outbox `id`
- attempt count, `last_error`, and escalation state from `notification_outbox`
- correlation fields (`tradeId`, `actionKey`, `requestId`, `txHash`, `runKey`)

## Rollback Procedure

1. Revert to previous known-good notifications package commit. The `notification_outbox` migrations are additive and may stay applied; an older image ignores the table. Before reverting, drain or record any `PENDING` and `DEAD_LETTER` rows, because the older image will not deliver them.
2. Restore prior template version mapping in `NOTIFICATION_TEMPLATE_VERSIONS`.
3. Re-run notifications tests and the deterministic gate probe:
   - `pnpm --filter ./notifications run build`
   - `scripts/notifications-gate.sh runtime`
4. Confirm no secrets are logged and retry bounds are still enforced.

## Runtime Health + Release Evidence

- Profile-level wiring health checks:
  - `scripts/cotsel.sh health`
  - `scripts/cotsel.sh health`
- Deterministic critical-path probe:
  - `scripts/notifications-gate.sh runtime`
  - Report output: `reports/notifications/runtime.json`
- CI evidence artifact:
  - `ci-report-notifications-gate` from `.github/workflows/release-gate.yml`
  - Contains deterministic probe output for:
    - `ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE`
    - `RECONCILIATION_CRITICAL_DRIFT`

## Safety Requirements

- Do not log webhook secrets, tokens, or full credentialed URLs.
- Keep retry attempts bounded.
- Keep dedup key stable and deterministic per event identity.
- Do not delete or rewrite settled `notification_outbox` rows; redrive dead letters as new rows.

## Verification Commands

```bash
pnpm --filter ./notifications run test --if-present
pnpm --filter ./notifications run lint
pnpm --filter ./notifications run build
scripts/notifications-gate.sh runtime
```
