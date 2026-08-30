# ADR-0414: Durable Gasless Command Dispatch

- Status: Accepted for implementation; deployed acceptance remains open
- Date: 2026-08-29
- Related issue: [#646](https://github.com/Agroasys/Cotsel/issues/646)

## Context

Gateway currently serializes gasless settlement work with a process-local Promise queue. The
PostgreSQL advisory lock prevents concurrent relayer nonce use, and the transaction-outcome tables
preserve a signed transaction identity before broadcast. However, an accepted request can still be
lost if the process stops before the Promise runs. The Promise queue also has no durable lease,
attempt history, dead-letter state, or restart scan.

The repository's job and eventing strategy permits a PostgreSQL job table when the business
transition and job record share one transaction. Adding SQS alone would not provide that atomic
boundary and would add another failure window between PostgreSQL and SQS.

## Decision

Gateway will use a PostgreSQL-backed gasless command table for the current single-region,
Multi-AZ deployment.

1. Static request, authorization, chain, contract, expiry, handoff, and capacity checks run before
   acceptance.
2. The `accepted` settlement event, its callback record, and one command row are committed in one
   database transaction. A failure in any write rolls back all three.
3. The command identity is unique for the application request and for the bound financial intent.
   A duplicate attaches to the existing command. It does not create new work.
4. Workers claim due commands with an owner and an expiring lease. Only the current lease owner may
   complete, retry, or dead-letter an attempt.
5. Each claim creates append-only attempt evidence. A recoverable pre-broadcast failure receives a
   bounded retry with backoff. Exhausted or non-recoverable work enters a visible dead-letter state.
6. A worker checks for an existing transaction outcome for the application request immediately
   before signing. If a durable transaction identity exists, the worker never signs or broadcasts a
   replacement. The transaction-outcome reconciler owns the original hash until it is terminal.
7. Startup and periodic scans reclaim expired leases. A process-local wake-up may reduce latency,
   but it is not the durability mechanism.
8. Intake fails closed when the configured pending-work limit is reached. Readiness and logs expose
   pending count, oldest age, expired leases, dead-letter count, and retry activity.
9. The HTTP request may wait for the current worker. If the connection or process is lost, a retry
   with the same idempotency key resolves the durable command or transaction outcome. It must not
   create another command or transaction.

The existing PostgreSQL advisory broadcast lock remains as a second concurrency control around
signing and broadcast. It does not replace command leases.

## Command Data and Access

The command payload contains the exact participant authorization required after restart. It is not
logged or returned by operational endpoints. It is stored only in the encrypted Gateway database,
sent over required database TLS, and accessible only to the Gateway database role. Private keys,
managed-signer credentials, RPC credentials, and service-auth secrets are never stored in a command.

Terminal payload retention and purge evidence are operational controls. A purge must retain command
identity, attempt history, transaction hash, terminal classification, and reconciliation references.

## Failure Rules

- A crash before claim leaves a pending command for another worker.
- A crash while a lease is active leaves the command reclaimable after lease expiry.
- A crash during signing is retryable only when no durable transaction identity exists.
- A crash after transaction identity persistence never causes automatic rebroadcast.
- A provider timeout, ambiguous broadcast, or unknown confirmation is owned by the existing
  transaction-outcome reconciler.
- A deterministic validation, authorization, simulation, or contract error is not retried as an
  infrastructure outage.
- Dead-letter redrive requires an operator action and a fresh check for an existing transaction
  identity. Redrive cannot bypass expiry or authorization validation.

## Alternatives Considered

### SQS with a PostgreSQL outbox

This is valid but adds an outbox publisher, SQS, DLQ, and another operational boundary. It does not
improve the current single-database command authority enough to justify the extra moving parts for
the staging lane. It remains an option if independent worker scaling or cross-service delivery later
requires it.

### Redis or BullMQ

Rejected. Redis is support infrastructure and is not an approved source of truth for settlement or
payments-grade work.

### Keep the in-process queue and rely on idempotency

Rejected. HTTP idempotency cannot recover an accepted closure that disappeared with the process.

## Consequences

- Accepted command state and dispatch are atomic and restart-safe.
- Gateway needs a leased worker loop, command-attempt storage, backlog telemetry, and a controlled
  redrive path.
- The request API keeps its existing successful response. Recovery responses may report a durable
  pending or owned-exception state instead of fabricating a terminal chain result.
- Local and PostgreSQL tests are prerequisites. Issue #646 remains open until deployed crash,
  duplicate, lease-expiry, poison, redrive, overload, and reconciliation exercises pass against one
  pinned candidate.
- `docs/runbooks/wp2-durable-command-rehearsal.md` defines the deployed exercise and containment
  procedure. `scripts/check-wp2-durability-rehearsal.mjs` rejects incomplete or stale reports.

## Rollback

Pause gasless intake and broadcast before rolling back. Keep the command and transaction-outcome
tables. A rollback image is allowed only if it can scan and safely resolve all non-terminal commands,
or if those commands are first moved to an operator-owned exception state without rebroadcast. Never
drop the tables or delete command payloads while non-terminal work exists.
