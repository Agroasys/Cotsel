# Gasless transaction outcome recovery

## Status and authority

This procedure controls WP-2 recovery when a Gateway gasless transaction has a
known signed hash but an unknown broadcast or confirmation result. It does not
authorize a replacement transaction, signer change, contract change, or manual
database state change.

Use this procedure for raw-private-key staging execution and managed KMS or MPC
execution. Production must use the separately approved managed-custody policy.

## Safety invariant

Gateway performs these steps in order:

1. Build and sign one transaction.
2. Derive its canonical hash, signer, nonce, chain, destination, fee fields,
   calldata hash, and intent hash.
3. Commit the identity and a `broadcast_pending` event to PostgreSQL.
4. Broadcast the same signed bytes once.
5. Record `broadcast_unknown` when the send result is ambiguous, or
   `confirmation_pending` when the provider accepts the canonical hash.
6. Resolve the original hash from a receipt after a timeout or restart.

The service never responds to a nonce error, timeout, connection loss, or
provider 5xx by signing and broadcasting another transaction. The idempotency
reservation remains held after a persisted financial identity exists.

## Outcome meanings

| Status                 | Meaning                                                                 | Operator action                         |
| ---------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `broadcast_pending`    | Identity committed; the process may have stopped before or during send. | Wait for automatic recovery.            |
| `broadcast_unknown`    | The provider did not prove whether it accepted the hash.                | Reconcile the original hash.            |
| `confirmation_pending` | The provider recognizes the hash, but no terminal receipt is recorded.  | Wait for the configured confirmation.   |
| `confirmed`            | A successful receipt is durably recorded.                               | Verify indexer and reconciliation data. |
| `reverted`             | A failed receipt is durably recorded.                                   | Investigate; do not replay blindly.     |
| `replaced`             | A separately proven transaction consumed the signer nonce.              | Follow approved replacement evidence.   |
| `failed`               | Failure occurred before any broadcast could have happened.              | A new request may be considered.        |

## Automatic recovery

`GATEWAY_GASLESS_OUTCOME_RECONCILIATION_INTERVAL_MS` controls the polling
interval and must be at least 1000 ms. On startup and at each interval, Gateway:

1. Loads unresolved outcomes and terminal outcomes not yet projected to the
   settlement record.
2. Looks up the stored transaction hash.
3. Records and projects a successful or reverted receipt.
4. Records `confirmation_pending` when the transaction is visible without a
   receipt.
5. Queries both the latest confirmed signer nonce and the pending signer nonce
   when the hash is not visible.
6. Converts the record to `broadcast_unknown` with explicit evidence that the
   transaction is absent, the pending nonce advanced, or the confirmed nonce
   advanced.
7. Leaves unresolved records visible and emits a structured warning with the
   stored transaction nonce and both observed signer nonces.

Nonce advancement does not prove that the intended transaction succeeded. The
worker therefore does not mark an absent hash as confirmed, reverted, or
replaced. An operator must compare the exact hash, indexer event, contract
state, and any separately proven replacement before accepting a terminal
outcome.

The recovery worker has no broadcast method and cannot create a replacement.

## Operator verification

1. Identify the request by application request ID or transaction hash. Do not
   copy signed transaction bytes, credentials, or authenticated RPC URLs into
   tickets.
2. Confirm one row exists in `gasless_transaction_outcomes` and that its chain,
   signer, nonce, destination, resource, and operation match the request.
3. Confirm `gasless_transaction_outcome_events` contains an append-only state
   history.
4. Confirm the idempotency key remains reserved while the outcome is unresolved.
5. Query both managed RPC providers for the exact hash and require chain 84532
   in Base Sepolia staging.
6. Compare the receipt with the indexer event and settlement handoff.
7. Escalate an outcome that remains unknown beyond the agreed incident window.

Never change an outcome row manually to make a test pass.

## Fault rehearsal

For a controlled staging fixture:

1. Capture the source commit, image digest, task definition, task ARN, request
   ID, transaction hash, and start time.
2. Stop the task only after the durable `broadcast_pending` record exists and
   before the HTTP request completes.
3. Start the same reviewed task definition.
4. Prove recovery resolves the original hash.
5. Prove the signer and RPC broadcast logs contain one signing request and at
   most one broadcast attempt for that identity.
6. Repeat the original idempotency key and prove no new transaction is created.
7. Verify the final handoff, indexer event, callback, and reconciliation refer
   to the same hash.

Local unit and PostgreSQL tests are prerequisites, not substitutes for this
staging rehearsal.

## Rollback

An application rollback may use the preceding immutable image only if that
image understands the active outcome schema and does not restore automatic
nonce retries. Do not roll back or delete the outcome tables or their event
history. If no compatible image exists, pause gasless broadcasts and keep the
recovery worker running until the original hashes are resolved.
