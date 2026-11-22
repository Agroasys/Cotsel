# Execution adapters, custody modes and the custody firewall

Status: interfaces, router and conformance suite implemented in `@agroasys/sdk`
(`sdk/src/execution/`, issue #942). No service routes through them yet; moving
today's signer, wallet and RPC paths onto them is #956, and licensed providers are
#943.

## Why

Cotsel reaches wallets, signers, funding rails, payout and ramp providers, and
chains through code wired directly into each service. Nothing declares how much
custody a deployment accepts, so nothing stops a settlement from reaching a
provider that holds funds. This module adds:

- one interface per execution capability;
- a custody mode declared per deployment and recorded per settlement;
- a firewall, enforced in the router and again at every adapter entry point;
- a router that selects adapters from validated configuration;
- a conformance suite every adapter must pass.

Cotsel itself is never the custodian in any mode. The mode states what the
_providers_ Cotsel routes to may hold.

## Capabilities

| Capability | Request payload                                              | A `succeeded` result must report                                               |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `wallet`   | `participantRef`, `chainId`                                  | `address`, a valid EVM address                                                 |
| `signing`  | `intent` (`ManagedSignerTransactionIntent`)                  | `signedTransaction`, which must pass `validateManagedSignerTransaction` (#645) |
| `funding`  | `chainId`, `payerRef`, `destination` (EVM address), `amount` | `amount` and `recipient` equal to the request                                  |
| `payout`   | `recipientRef`, `amount`                                     | `amount` and `recipient` equal to the request                                  |
| `ramp`     | `direction`, `sourceRef`, `destinationRef`, `amount`         | `amount` and `recipient` (the destination) equal to the request                |
| `chain`    | `chainId`, `signedTransaction`                               | `transactionHash` equal to the hash of the signed transaction                  |

Amounts are `ExactAmount` values: an asset identifier and a `bigint` in base units.
`exactAmount()` accepts a `bigint` or a canonical decimal integer string and rejects
numbers, decimals, signs, exponents and leading zeros (#650).

## Operations

Every adapter implements three operations:

| Operation   | Contract                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `preflight` | Checks a request and returns `{ ok, problems }`. No side effects.                                                    |
| `submit`    | Starts the operation once per idempotency key and returns `pending`, `succeeded`, `failed` or `unknown`.             |
| `status`    | Reports the operation for an idempotency key (the operation reference is optional), or `not_found` if there is none. |

`unknown` means Cotsel cannot tell what happened. It is never success and never a
reason to resubmit: the caller resolves it through `status`, following the
broadcast-identity recovery in #644.

## Custody modes and the firewall

| Mode                 | Allows adapters of class                                  |
| -------------------- | --------------------------------------------------------- |
| `non_custodial`      | `non_custodial`                                           |
| `composed_partner`   | `non_custodial`, `composed_partner`                       |
| `licensed_custodial` | `non_custodial`, `composed_partner`, `licensed_custodial` |

Agroasys runs `non_custodial`: embedded wallets, the AWS KMS oracle signer and
direct USDC funding.

The firewall rejects a call with `CustodyFirewallError` when:

- the settlement's recorded mode is not a declared mode (`custody_mode_invalid`);
- the settlement's recorded mode allows more custody than the deployment
  (`settlement_mode_exceeds_deployment`);
- the adapter's class needs more custody than the settlement's mode allows
  (`adapter_class_forbidden`).

It runs twice. The router checks before every call, and `guardExecutionAdapter`
checks again at each adapter entry point, so calling an adapter directly cannot
bypass it. Every adapter must be exported through `guardExecutionAdapter`; the
router also wraps everything registered with it. Rejections raise a
`custody_firewall_rejected` alert.

## Configuration and readiness

```json
{ "custodyMode": "non_custodial", "adapters": { "signing": "aws-kms-signer", "chain": "base-rpc" } }
```

`createExecutionRouter` validates this against the registered adapters. It does
not throw: problems are reported by `readiness()`, and every routing call throws
`ExecutionConfigError` until they are fixed. A service should return its
readiness failure when `readiness().ready` is false. Problems include:

- an unknown or missing custody mode;
- an unknown top-level key or capability;
- an adapter that is not registered, serves another capability, or needs more
  custody than the mode allows;
- duplicate or invalid adapter descriptors;
- a required capability with no route;
- an invalid timeout.

`declaration()` returns the custody mode, each route's adapter id, version and
class, and a `configHash` over them. Every routed result carries the
`custodyMode` and `configHash` it ran under, so evidence shows which routing
applied.

## Router behaviour

The router snapshots each submit before validation and fingerprinting. Later
caller mutations cannot change the approved request. Signing observations are
checked against a separate copy of the intent. Chain payloads must contain a
signed transaction for the requested chain; otherwise no adapter is called.

| Case                                                                          | Result                                                                                  |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Duplicate submit, same key and request                                        | One provider operation; later calls return the stored result with `replayed: true`.     |
| Concurrent submits, same key                                                  | One provider operation.                                                                 |
| Same key, different request                                                   | `ExecutionIdempotencyConflictError`; the provider is not called.                        |
| Submit times out                                                              | `unknown` / `timeout`, stored; a retry returns it without calling the provider.         |
| Adapter throws after submit                                                   | `unknown` / `adapter_error`.                                                            |
| A claim exists but has no result (crash, other worker)                        | `unknown` / `submission_in_flight`; resolve through `status`.                           |
| Malformed result, or `succeeded` without a reference                          | `unknown` / `result_invalid` or `operation_ref_missing`.                                |
| Reported amount, asset, recipient, signature or hash differs from the request | `unknown` / `observation_mismatch:<reason>` and an `observation_mismatch` alert.        |
| `status` after `unknown`                                                      | Goes to the adapter that took the submit; a verified answer replaces the stored result. |

The router stores claims through `ExecutionIdempotencyStore`. `claim` must be an
atomic insert-if-absent shared by every process. The bundled in-memory store is for
tests and single-process tools only; the durable store belongs with #644.

Stored results retain the verified observation, including a wallet address or
signed transaction, so a retry after a lost response returns the usable result.
Returned observations are independent copies. Durable stores must preserve
`bigint` amounts losslessly and protect signing output as sensitive data.
Malformed observations return `unknown` and raise an alert. A malformed status
response does not overwrite previously verified evidence.

Alerts go to `onAlert` and carry reason codes only, never payloads, signatures or
credentials. They are inputs to #953.

## Conformance suite

`runExecutionAdapterConformance(fixture)` runs every check below against an adapter
backed by a sandbox or fake provider, and reports each result. Any test runner can
use it.

| Check                                                  | Operation        | Requirement                                                                                                                            |
| ------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `descriptor.valid`                                     | descriptor       | Stable id, one known capability, a known custody class and a version.                                                                  |
| `preflight.accepts_valid_request_without_side_effects` | preflight        | Returns `{ ok, problems }` for a valid request and performs no provider operation.                                                     |
| `submit.reports_a_known_outcome`                       | submit           | Returns a known outcome; `succeeded` carries an operation reference and an observation matching the request.                           |
| `submit.one_operation_per_idempotency_key`             | submit           | Two submits with one key perform one provider operation and return the same reference.                                                 |
| `status.resolves_from_idempotency_key`                 | status           | Status with only the key finds the submitted operation, so `unknown` can be recovered without the reference.                           |
| `status.not_found_for_unused_key`                      | status           | Status for a key never submitted returns `not_found`, neither throwing nor reporting another outcome.                                  |
| `custody_firewall.enforced_at_adapter_entry`           | custody_firewall | Every entry point rejects a forbidding or undeclared mode with `CustodyFirewallError` and no provider operation; permitted modes pass. |

`sdk/tests/executionConformance.test.ts` runs the suite against a reference adapter
for every capability and custody class. It also proves that the suite catches
adapters that repeat operations, misreport amounts, omit observations, or skip
the entry-point firewall.

## Out of scope

- Moving existing code onto the interfaces (#956).
- Concrete licensed providers (#943) and independent status observation (#944).
- Signer custody decisions (#645, #649). The signing interface takes the existing
  `ManagedSignerTransactionIntent` and verifies results with the existing #645
  check, so either outcome fits behind it.
