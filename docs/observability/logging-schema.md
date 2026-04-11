# Logging Schema Baseline

All services should emit JSON logs with these baseline top-level fields on every
record:

- `level`
- `timestamp`
- `service`
- `env`
- `message` for standard logs, or `action` for explicit audit events

Use `null` for fields that are not applicable. Do not omit known correlation or
audit fields just because a specific event does not populate them.

## Standard Audit Envelope v1

`AuditEnvelopeV1` is the canonical flat-field contract for audit-grade logs,
operator evidence packets, and incident artifacts.

### Required baseline fields

| Field       | Required                                                                   | Meaning                                                                               |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `level`     | yes                                                                        | Log severity. `audit` is permitted for explicit audit records.                        |
| `timestamp` | yes                                                                        | ISO-8601 UTC timestamp for the emitted record.                                        |
| `service`   | yes                                                                        | Runtime owner of the event (`gateway`, `oracle`, `treasury`, `reconciliation`, etc.). |
| `env`       | yes                                                                        | Runtime environment label.                                                            |
| `message`   | yes for standard logs                                                      | Human-readable event summary.                                                         |
| `action`    | yes for explicit audit events when `message` is not the primary event name | Stable audit event/action name.                                                       |

Rule:

- Every audit-grade record MUST contain at least one of `message` or `action`.

### Correlation and request linkage

| Field           | Required when available | Meaning                                                                            |
| --------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `tradeId`       | yes                     | Protocol trade identifier tied to the business action.                             |
| `actionKey`     | yes                     | Stable business-action/idempotency key across retries.                             |
| `requestId`     | yes                     | Request-scoped identifier for one concrete API/job execution.                      |
| `correlationId` | yes                     | Stable cross-service correlation ID linking related requests and operator actions. |
| `traceId`       | yes                     | Transport or ingress trace identifier.                                             |

Rules:

- Keep `requestId` stable across retries for the same submitted request.
- Keep `actionKey` stable across retries for the same business intent.
- `correlationId` should outlive any single retry and link dashboard/gateway,
  service, and incident artifacts.

### Actor, intent, and outcome fields

| Field            | Required when available | Meaning                                                                                                            |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `actorSessionId` | yes                     | Auth/session identity for operator or client actor.                                                                |
| `actorUserId`    | yes                     | Human/user principal when known.                                                                                   |
| `actorWallet`    | yes                     | Wallet address of the acting subject when known.                                                                   |
| `actorRole`      | yes                     | Authorization role that allowed the action.                                                                        |
| `intent`         | yes                     | Stable operator/business intent such as `create_trade`, `pause_claims`, `compliance_deny`, `reconcile_run`.        |
| `outcome`        | yes                     | Stable result such as `requested`, `queued`, `succeeded`, `rejected`, `blocked`, `failed`, `degraded`, or `stale`. |

Rules:

- For mutating or operator-reviewed paths, `intent` and `outcome` should be
  explicit rather than inferred from free-form text.
- If no authenticated actor exists, set actor fields to `null`.

### Chain and execution references

| Field         | Required when available | Meaning                                                      |
| ------------- | ----------------------- | ------------------------------------------------------------ |
| `txHash`      | yes                     | On-chain transaction hash for state-changing EVM actions.    |
| `blockNumber` | yes                     | Block number for the finalized transaction/event when known. |
| `chainId`     | yes                     | Numeric chain identifier.                                    |
| `networkName` | yes                     | Human-readable network label used by operators/runbooks.     |

### Failure classification fields

| Field       | Required when available | Meaning                                                                    |
| ----------- | ----------------------- | -------------------------------------------------------------------------- |
| `errorCode` | yes                     | Stable machine-readable classification for client/business/infra failures. |
| `error`     | yes                     | Normalized error summary safe for logs.                                    |

### Sensitive-data rule

AuditEnvelopeV1 never permits raw secrets or full sensitive materials in logs.
At minimum, never log:

- private keys
- seed phrases
- API secrets
- bearer tokens
- full HMAC secrets or full signed canonical strings
- raw banking details

Data-classification enforcement is governed by
`docs/security/data-classification-policy.md` and the release-gate guard
`scripts/tests/data-classification-guard.mjs`.

## Service adoption status

`AuditEnvelopeV1` is the canonical contract, but current service implementations
do not all emit every field yet. The matrix below is the current repo truth and
must be used during incident review instead of assuming full adoption.

| Service          | Current emitted baseline                                                                                                                                                                                      | Current gap against `AuditEnvelopeV1`                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`        | `level`, `timestamp`, `message`, `service`, `env`, `requestId`, `correlationId`, `userId`, `walletAddress`, `gatewayRoles`, `route`, `method`, `statusCode`, `durationMs` via `gateway/src/logging/logger.ts` | No single shared runtime envelope yet for `tradeId`, `actionKey`, `intent`, `outcome`, or canonical actor field names; audit ledgers carry richer metadata than generic logs. |
| `oracle`         | `level`, `timestamp`, `message` or `action`, `service`, `env`, `tradeId`, `actionKey`, `requestId`, `txHash`, `traceId` via `oracle/src/utils/logger.ts`                                                      | No first-class `correlationId`; no canonical actor fields; `intent` and `outcome` remain event-specific.                                                                      |
| `treasury`       | `level`, `timestamp`, `message`, `service`, `env`, `tradeId`, `actionKey`, `requestId`, `txHash`, `traceId` via `treasury/src/utils/logger.ts`                                                                | No `correlationId`, actor fields, explicit `intent`, explicit `outcome`, or chain metadata beyond `txHash`.                                                                   |
| `reconciliation` | `level`, `timestamp`, `message`, `service`, `env`, `tradeId`, `actionKey`, `requestId`, `txHash`, `chainId`, `networkName`, `traceId` via `reconciliation/src/utils/logger.ts`                                | No `correlationId`, actor fields, explicit `intent`, or explicit `outcome`.                                                                                                   |

Operational rule:

- When a service does not yet emit a field directly, operators must source it
  from the nearest authoritative ledger, request record, or incident artifact
  rather than inventing it in post-processing.

## Metric counter names

The following counters are emitted through service logs as `metric` events:

- `auth_failures_total`
- `replay_rejects_total`
- `oracle_exhausted_retries_total`
- `oracle_redrive_attempts_total`
- `reconciliation_drift_classifications_total`

## Terminal failure logging

Terminal failures must include enough context for support triage:

- `service`
- `env`
- `requestId`
- `correlationId` when available
- `tradeId` when available
- `actionKey` when available
- `traceId` when available
- `txHash` when available
- normalized `errorCode` and `error`
- `outcome=failed` or `outcome=degraded`
