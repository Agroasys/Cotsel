# Gateway Dead-Letter Workflow

## Purpose
Define the gateway-owned failed-operation ledger, replay eligibility rules, and operator replay workflow introduced under issue `#124`.

Source of truth implementation:
- `gateway/src/core/failedOperationStore.ts`
- `gateway/src/core/errorHandlerWorkflow.ts`
- `gateway/src/core/settlementCallbackDispatcher.ts`
- `scripts/gateway-dead-letter-workflow.mjs`

## What is persisted
The gateway records a failed operation when:
- a replay-eligible governance queue mutation fails due to infrastructure or unexpected error
- a replay-eligible compliance mutation fails due to infrastructure or unexpected error
- a settlement callback delivery exhausts retries and reaches `dead_letter`

Each failed-operation record persists:
- operation type
- target service
- request route + method
- request payload hash
- request payload snapshot
- request ID
- correlation ID when available
- idempotency key when available
- actor/session snapshot when available
- first failure time
- last failure time
- retry count
- terminal error class/code/message
- replay eligibility

## Failure classes and replay rule
Replay is allowed only for:
- `infrastructure`
- `unexpected`

Replay is not recorded for:
- client contract failures (`400`, `401`, `403`, `404`)
- business/state conflicts (`409`)

Operator rule:
- do not replay a failed operation until the underlying dependency failure is understood and contained
- preserve the original intent identity: replay keeps the same `requestId`, `correlationId`, and `idempotencyKey`
- treat replay as a controlled reattempt of the same logical action, not a new operator request

## Supported replay types
- `governance.queue_action`
- `compliance.create_decision`
- `compliance.block_oracle_progression`
- `compliance.resume_oracle_progression`
- `settlement.callback_delivery`

## CLI
List open failed operations:

```bash
node scripts/gateway-dead-letter-workflow.mjs list
```

List all failed operations as JSON:

```bash
node scripts/gateway-dead-letter-workflow.mjs list --all --json
```

Replay one failed operation:

```bash
node scripts/gateway-dead-letter-workflow.mjs replay <failedOperationId>
```

Replay one failed operation and emit JSON:

```bash
node scripts/gateway-dead-letter-workflow.mjs replay <failedOperationId> --json
```

## Operator replay procedure
1. Confirm the failure class is `infrastructure` or `unexpected`.
2. Confirm the dependency issue is resolved:
   - governance/compliance writes: Postgres and gateway write path healthy
   - settlement callback delivery: target callback endpoint healthy and auth material valid
3. List the failed operation and capture:
   - `failedOperationId`
   - `operationType`
   - `retryCount`
   - `requestId`
   - `correlationId`
   - `idempotencyKey`
4. Run the replay command.
5. Confirm the record transitions to `replayed`. If replay fails, it transitions to `replay_failed` and retains the latest terminal error.
6. Attach the replay output to the incident or operator evidence packet.

## Incident ownership
- gateway/platform owner: owns the failed-operation ledger and replay execution workflow
- service owner: owns the underlying dependency fix when the failure source is service-specific
- treasury or reconciliation operator: consulted when the failed operation affects settlement callback delivery or downstream evidence

## Evidence requirements
Record these fields in the incident or operator evidence packet:
- `failedOperationId`
- `operationType`
- `requestId`
- `correlationId`
- `idempotencyKey`
- failure class/code/message
- replay result
- ticket reference and operator identity

