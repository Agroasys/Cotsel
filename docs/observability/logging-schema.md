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

## Telemetry field schema

WP-8 COMP-04 and FAIL-17. Telemetry is default-deny: a field reaches a log
line, a metric event, or an alert only when the shared schema classifies it.

`@agroasys/shared-telemetry` applies the schema to every record before it is
written. The gateway, Oracle, treasury, reconciliation, Ricardian, auth,
relayer, and indexer loggers use it. The indexer applies it to Subsquid
dependency records as well. The notifications library applies it to its
fallback logger and scrubs every value it renders into a webhook body.

The schema lives in `shared-telemetry/fieldPolicy.js`
(`telemetry-schema.v1`). It handles each field as follows:

| Field                                           | Handling                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Classified operational field                    | Emitted. String values are scrubbed.                                                        |
| Endpoint field, such as `rpcUrl`                | Reduced to scheme and host. A URL path, query, or user part becomes `/[redacted]`.          |
| Request path field: `route`, `path`, `endpoint` | Query string and fragment replaced with `?[redacted]`. The path is kept.                    |
| Client address field `ip`                       | Truncated to the network: IPv4 `/24`, IPv6 `/48`.                                           |
| Prohibited name at any depth                    | Value replaced with `[REDACTED]`. Classification cannot override this.                      |
| Unclassified name                               | Removed. Its dotted path is listed in `telemetryDroppedFields`. The value is never written. |

Prohibited names include the names in the data-classification policy and any
name that contains a credential word such as "secret", "password",
"authorization", or "cookie".

The schema scrubs every emitted string, including `message` and `error`. It
replaces these values inside free text:

- PEM private-key blocks
- JSON Web Tokens and `Bearer` or `Basic` credentials
- the path, query, and user part of any absolute URL
- the query string and fragment of a relative request target, such as
  `/trades?...`
- email addresses
- IBANs that pass the ISO 13616 checksum

The schema also bounds each record. It truncates strings after 4,096
characters, arrays after 50 items, and nesting after 6 levels. It replaces
binary values with `[binary]` and reference cycles with `[circular]`.

Limits:

- A raw 32-byte hex value in free text is not scrubbed. It cannot be told
  apart from a transaction hash. Field names carry that protection instead.
- Dashboards, traces, pager routing, retention, and deletion are deployment
  controls. This schema does not supply them.

### Operator reading of `telemetryDroppedFields`

A record that contains `telemetryDroppedFields` shows a classification gap,
not a leak: the value was not written. Raise it with the shared-package owner
in `docs/owners.md` so the field can be classified or removed.

### Classify a new log field

The release gate runs `scripts/tests/telemetry-field-schema-guard.mjs`. The
guard fails when a telemetry call names a literal field that is unclassified
or prohibited. Telemetry calls are logger calls and direct writes through
`serializeTelemetryRecord`, `sanitizeTelemetryRecord`, or the indexer
`logBootstrapEvent`. Fields that come from spread or variable objects are not
visible to the guard; the runtime schema drops them if they are unclassified.

Write telemetry only through a service logger or `serializeTelemetryRecord`.
Do not write `JSON.stringify` output to stdout or stderr directly.

To add a field:

1. Select its class in `docs/security/data-classification-policy.md`.
2. Add the field name to the matching list in `shared-telemetry/fieldPolicy.js`.
3. Run `node --test scripts/tests/telemetry-field-schema-guard.test.mjs`.
4. Run `pnpm --filter @agroasys/shared-telemetry run test`.

Do not classify a value that the data-classification policy prohibits.
Log a reference, hash, or masked suffix of that value instead.

## Public error responses

WP-10 I-06. A response never carries internal failure text: no stack trace,
SQL or query text, host or RPC URL, signer or provider output, or secret. The
full error goes to the service log under the `correlationId` the caller is given.

| Failure                                                          | Response                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Request validation, domain refusal, conflict                     | Its existing stable code and caller-facing message.                                                                |
| Database, network, RPC, signer, provider, timeout, or unexpected | `InternalError` (gateway: `INTERNAL_ERROR`, or `UPSTREAM_UNAVAILABLE` for a named upstream) and a generic message. |

- `ricardian`, `treasury`, `oracle` and `auth` answer unexpected failures through
  `sendInternalFailure` in `@agroasys/shared-http`. The body carries
  `correlationId`, and the same value is set as the `x-correlation-id` header.
- The correlation ID reuses a well-formed inbound `x-correlation-id` or
  `x-request-id` (8 to 128 characters of `A-Za-z0-9._:-`), so a gateway request
  can be followed into the service log. Anything else gets a fresh UUID; caller
  text is never echoed.
- Only an explicitly caller-safe error keeps its message: `HttpError`, a
  `CallerSafeError` from `@agroasys/shared-http`, or a named domain error class a
  service maps itself. Every other error is internal, including a plain `Error`:
  database drivers and GraphQL clients raise those with raw upstream text
  (`isCallerSafeError`).
- The gateway returns `requestId` and `traceId`. Raw upstream text goes in
  `GatewayError.diagnostics`, which is logged by the error handler and never
  serialized; `details` holds only stable, non-sensitive fields.
- Oracle trigger results keep domain refusal text. Network and contract failures
  return `Oracle <type> failure; detail is recorded on the trigger`; the full
  text stays in the trigger's `last_error` and the logs.

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
