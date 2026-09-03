# WP-2 durable command rehearsal

## Purpose

Use this procedure to accept issue [#646](https://github.com/Agroasys/Cotsel/issues/646).

This procedure covers durable gasless commands and callback delivery leases.
It proves crash recovery, poison handling, redrive, and overload containment.

Local tests are prerequisites. They are not staging evidence.

## Authority

The Gateway and Platform owners authorize the rehearsal window.
Operations controls task termination and service recovery.
The acceptance reviewer must not produce the evidence.

The rehearsal uses Base Sepolia staging only.
It must not use public participants or commercial value.
It must not change contract authority or signer custody.

## Safety rules

- Freeze one candidate before the rehearsal.
- Use one reviewed candidate manifest.
- Use the candidate's immutable Gateway image digest.
- Use the candidate's reviewed task definition.
- Use approved bounded-value fixtures only.
- Keep Treasury stopped.
- Keep database backups and point-in-time recovery active.
- Do not modify command rows manually.
- Do not delete command or attempt history.
- Do not copy command payloads into evidence.
- Do not record signed transaction bytes.
- Do not record credentials or authenticated RPC URLs.
- Stop if a transaction identity becomes untracked.
- Stop if a second financial effect is possible.
- Stop if chain ID differs from `84532`.
- Stop if the runtime differs from the candidate manifest.

## Required candidate identity

Record these values before any mutation:

- candidate ID and canonical manifest digest;
- Cotsel source commit and image-producing workflow;
- Gateway image digest;
- AWS account, region, cluster, and service;
- task definition and running task ARNs;
- Gateway migration head and checksum;
- redacted configuration digest;
- chain ID, contract address, and deployment block;
- signer and RPC provider modes;
- operator, reviewer, and approved rehearsal window.

The report validator rejects drift from the manifest.

## Required lifecycle events

Use structured events to identify each boundary.

| Boundary                        | Event type                                         |
| ------------------------------- | -------------------------------------------------- |
| Command claim                   | `gateway.gasless_command.claimed`                  |
| Signing starts                  | `gateway.gasless_transaction.signing_started`      |
| Signing completes               | `gateway.gasless_transaction.signing_completed`    |
| Transaction identity persists   | `gateway.gasless_transaction.identity_persisted`   |
| Provider returns a response     | `gateway.gasless_transaction.broadcast_response`   |
| Confirmation becomes pending    | `gateway.gasless_transaction.confirmation_pending` |
| Reconciliation owns the outcome | `gateway.gasless_command.outcome_owned`            |
| Command completes               | `gateway.gasless_command.completed`                |
| Retry is scheduled              | `gateway.gasless_command.retry_scheduled`          |
| Command reaches dead letter     | `gateway.gasless_command.dead_lettered`            |
| Operator redrives command       | `gateway.gasless_command.redriven`                 |

Never trigger from message text alone.
Match the event type and application request identifier.

## Evidence sources

Capture at least two independent references for each scenario.

Use these sources where applicable:

- CloudWatch log export or query reference;
- redacted PostgreSQL query result;
- ECS task and deployment event reference;
- managed signer audit reference;
- RPC provider request reference;
- Base Sepolia transaction and receipt;
- indexer event identity;
- callback delivery record;
- reconciliation result;
- operator notification delivery reference.

Do not use screenshots when structured evidence exists.

## Redacted database query

Use the Gateway runtime role through the approved verifier task.
Do not select `payload`, `result`, or `last_error_detail`.

```sql
SELECT
  command_id,
  application_request_id,
  resource_type,
  resource_id,
  operation,
  status,
  attempt_count,
  max_attempts,
  next_attempt_at,
  lease_owner,
  lease_expires_at,
  transaction_hash,
  last_error_code,
  completed_at,
  created_at,
  updated_at
FROM gasless_commands
WHERE application_request_id = :'application_request_id';

SELECT
  attempt_id,
  command_id,
  attempt_number,
  lease_owner,
  started_at,
  finished_at,
  outcome,
  transaction_hash,
  error_code
FROM gasless_command_attempts
WHERE command_id = :'command_id'
ORDER BY attempt_number;
```

Hash sensitive correlation identifiers before publishing the report.
Retain the protected raw export in the approved evidence store.

## Scenario matrix

Run every scenario against the same candidate.
Use a new fixture and idempotency key for each scenario.

### Before dequeue

1. Submit one valid signed command.
2. Confirm acceptance and durable command persistence.
3. Terminate the worker before its first claim.
4. Allow the service scheduler to replace the task.
5. Confirm one replacement claim.
6. Confirm one terminal result or owned exception.

Use a reviewed execution gate for deterministic timing.
Do not use timing guesses.

### Active lease worker crash

1. Wait for the command claim event.
2. Confirm the lease owner and expiry.
3. Terminate that task.
4. Wait for the lease to expire.
5. Confirm one replacement claim.
6. Confirm the stale owner performs no update.

### During signing

1. Use the approved managed-signer delay control.
2. Wait for the signing-started event.
3. Confirm no transaction identity exists.
4. Terminate the task while signing remains pending.
5. Remove the delay control.
6. Confirm safe replacement processing.
7. Confirm at most one broadcast and financial effect.

Do not weaken signer validation for this scenario.

### Immediately after broadcast

1. Use the approved provider response-delay control.
2. Forward the signed transaction once.
3. Keep the provider response pending.
4. Terminate the task after provider acceptance.
5. Restore the provider response path.
6. Confirm recovery uses the original transaction hash.
7. Confirm no restart rebroadcast occurs.

The provider control must preserve the candidate endpoint identity.

### During confirmation

1. Wait for the confirmation-pending event.
2. Terminate the owning task.
3. Allow task replacement.
4. Confirm the recovery worker queries the original hash.
5. Confirm one terminal result or owned exception.
6. Confirm no restart rebroadcast occurs.

### Duplicate delivery

1. Submit the same idempotency key concurrently.
2. Confirm one durable command exists.
3. Confirm all callers resolve to that command.
4. Confirm at most one transaction and financial effect.

### Expired lease reclaim

1. Terminate a worker with an active lease.
2. Wait for the configured lease expiry.
3. Confirm one `lease_expired` attempt result.
4. Confirm one successor lease.
5. Confirm stale-owner updates remain zero.

### Poison dead letter

1. Use an approved deterministic poison fixture.
2. Confirm bounded attempts and backoff.
3. Confirm append-only attempt history.
4. Confirm the final `dead_letter` state.
5. Confirm no broadcast or financial effect occurs.
6. Confirm the operator signal reaches its owner.

### Operator redrive

1. Select the poison fixture from the operations route.
2. Confirm no transaction identity exists.
3. Authorize one redrive with `operations:replay`.
4. Confirm one audit event and one extra attempt.
5. Confirm a repeated authorization is idempotent.
6. Confirm any new transaction remains singular.

Never redrive a command with a known transaction identity.

### Overload backpressure

1. Submit above the configured pending-work limit.
2. Confirm excess intake fails closed.
3. Confirm accepted commands remain durable.
4. Confirm no accepted command is lost.
5. Confirm backlog age and depth remain visible.
6. Confirm service recovery after backlog drainage.

### Callback lease reclaim

1. Claim one real callback delivery.
2. Terminate the worker before acknowledgement persistence.
3. Wait for the callback lease expiry.
4. Confirm a successor claims the stable event ID.
5. Confirm the receiver records one effect.
6. Confirm duplicate delivery is idempotent.

## Containment

Pause new gasless intake when any invariant fails.
Do not start Treasury.
Preserve the task, log, database, provider, and chain evidence.

Resolve the original transaction hash before any retry.
Reconcile the contract, indexer, callback, and operational state.
Use the preceding image only when it supports migration `005`.

Do not roll back the command or outcome tables.

## Report validation

Produce `cotsel.wp2-durability-rehearsal.v1` JSON.

The report root contains these fields:

- `candidateId`, `manifestSha256`, and `runId`;
- `startedAt`, `completedAt`, and `producedBy`;
- `blockers`, which must be an empty array;
- `runtime`, containing every pinned runtime identity;
- `scenarios`, containing each required scenario exactly once.

The runtime object contains these fields:

- environment, source commit, AWS account, and region;
- cluster, service, task definition, and task ARNs;
- Gateway image digest;
- migration head and migration checksum;
- chain ID and contract address;
- redacted configuration digest;
- signer, RPC, and off-ramp provider modes.

Each scenario contains its identifier and timestamps.
It also contains two evidence references and observed counters.
The validator tests show the exact machine-readable field names.
Those fixtures are not release evidence.

Validate the packet:

```bash
node scripts/check-wp2-durability-rehearsal.mjs \
  --manifest <candidate-manifest.json> \
  --report <wp2-durability-rehearsal.json>
```

The validator requires every scenario exactly once.
It rejects lost commands, duplicate effects, and restart rebroadcasts.
It rejects unaudited redrive and unresolved blockers.
It rejects evidence bound to another candidate.

Hash the validated report.
Add it to the evidence index for `B-04`, `H-18`, `INFRA-04`, and `FAIL-03`.
Route callback security evidence to the primary `FAIL-12` acceptance owner.

## Acceptance

Gateway, Platform, and Operations reviewers inspect the protected raw evidence.
The named reviewer records `Accepted` or `Rejected` for the exact candidate.

Keep issue #646 in Evidence Review until that decision exists.
A valid report is not self-acceptance.
