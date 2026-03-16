# Cotsel Job and Eventing Strategy

This document records the async boundary for Cotsel so contributors do not
accidentally treat Redis as a durable queue or source of truth.

- Durable jobs and event routing: SQS with DLQs for durable processing
  (webhooks, payouts, chain events, reconciliation, notifications) and
  EventBridge for internal event routing (`trade.updated`, `escrow.locked`,
  `docs.approved`).
- Non-critical async jobs: BullMQ (Redis) is permitted only for best-effort
  background tasks such as email sending and PDF generation.
- Redis usage boundary: Redis may be used for caching, short-lived locks, and
  rate limiting tokens only. Redis is never a source of truth for settlement,
  reconciliation, or payments-grade workflows.

Durable workflows must use SQS and DLQs so settlement, reconciliation, payout,
and event-driven processing can be retried and audited without relying on
volatile broker state. BullMQ is allowed only for non-critical background work,
and Redis is never a durable queue or source of truth in the Cotsel
architecture.
