# Cotsel Job and Eventing Strategy

This document records the async boundary for Cotsel so contributors do not
accidentally treat Redis as a durable queue or source of truth.

- Durable jobs: a transactionally coupled Postgres outbox/job table or SQS with
  a DLQ may be used for payments-grade processing. The selected implementation
  must persist the command or event atomically with its business-state change,
  provide cross-replica idempotency, bounded retries, dead-letter handling,
  redrive evidence and backlog-age alerts.
- Event routing: EventBridge is optional for cross-service fan-out. It is not
  the system of record and does not remove the requirement for a durable
  producer outbox.
- Non-critical async jobs: BullMQ (Redis) is permitted only for best-effort
  background tasks such as email sending and PDF generation.
- Redis usage boundary: Redis may be used for caching, short-lived locks, and
  rate limiting tokens only. Redis is never a source of truth for settlement,
  reconciliation, or payments-grade workflows.

The deployment architecture must make one explicit queue decision per critical
workflow. A Postgres-backed outbox is acceptable where the business transition
and outbox record share one database transaction. SQS is acceptable where the
producer has a transactional outbox or equivalent loss-prevention boundary and
the queue has a DLQ. The repository must not claim SQS or EventBridge is active
until the deployed infrastructure and runtime wiring exist. BullMQ is allowed
only for non-critical background work, and Redis is never a durable queue or
source of truth in the Cotsel architecture.
