# Stored settlement amount integrity

Audience: Gateway engineers and Finance/Data reviewers. Scope: #650, PostgreSQL handoffs and callback outbox records.

The gateway validates stored amounts before it returns a handoff or builds a callback. It also validates callback amounts before delivery. Unsupported magnitude, negative values and excess scale fail closed. The existing v1 response and callback number contracts remain available within their approved decimal limits.

The PostgreSQL callback projections return JSONB text. Validation uses the original numeric lexeme, even when the JSON decoder would round it. For example, `9999999999999.9901` must not become `9999999999999.99` and pass validation.

Invalid handoff amounts produce `INTERNAL_ERROR`. An event transaction that encounters such a handoff rolls back without an event or callback. An invalid queued callback stops the callback batch before any delivery lease is acquired. Scheduled polling logs a sanitized error and retries without terminating Gateway. `SETTLEMENT_CALLBACK_POLL_FAILED` includes `deliveryId` and `handoffId` for an invalid stored callback. After three consecutive failures, `SETTLEMENT_CALLBACK_POLL_STALLED` emits once per failure streak with `consecutiveFailureCount=3`. A successful outbox poll resets the signal. Route this stable error code to the existing critical operational log alert. No callback body or invalid amount is logged. Operators must resolve that record before the batch can resume. This deliberately contains the batch instead of silently skipping financial evidence.

## Investigation and recovery

Prerequisites: authorized database access, the affected release identity, and access to original request and reconciliation evidence.

1. Record the source SHA, environment, migration identity and affected request identifiers.
2. Retain the original row and callback evidence under the approved custody policy.
3. Compare the request, authorized instruction, stored amount and independent chain evidence.
4. Obtain the Finance/Data owners' decision before any financial data correction.
5. Review the correction and rollback procedure independently.
6. Have the authorized operator apply the reviewed correction.
7. Recheck the exact stored decimals against the independent evidence.
8. Reproduce the rejection and recovery checks on the affected candidate.
9. Resume delivery only after the owners accept the reconciliation result.

Do not round, clamp, delete or overwrite an amount to clear an error. This source change contains invalid data; it does not authorize corrections. Reverting the source restores unchecked numeric conversion and callback decoding. Keep the affected flow contained during rollback.

## Local verification

Use Node 22, PostgreSQL 16 on loopback port 5432, and the repository's pinned pnpm version. The test creates a unique database and runtime role. It runs the versioned migration manifest twice, uses runtime grants and row-level security, and removes its own resources.

Run `GATEWAY_TEST_USE_LOCAL_POSTGRES=true pnpm --filter gateway exec jest --runInBand tests/settlementAmount.postgres.test.ts`.

The test uses real HTTP listeners and PostgreSQL stores for handoffs, idempotency, authentication nonces and callback delivery. A controlled callback receiver verifies service authentication. Its development-only `express-rate-limit` 8.7.2 dependency provides bounded requests and a CodeQL-recognized guard. The version-specific release-age exception selects the upstream GHSA-j3cq-92fq-qg5f security fix. It checks exact stored decimal text, transport replay, changed monetary intent, cross-caller rejection, invalid ingress and tampered signatures. Unsupported stored values and an excess-scale JSONB callback exercise containment and controlled fixture recovery.

Hosted Gateway CI enables this suite through its existing PostgreSQL service and `SETTLEMENT_ACTIVITY_DATABASE_URL`. Outside those configured environments, the suite is explicitly skipped. Missing database access in an enabled run fails the test.

The v1 callback includes `displayAmount`; it does not include `assetAmount`. Asset amounts are checked at ingress, persistence and handoff retrieval. No callback schema change is introduced.

Local results are implementation evidence. They do not prove deployed amounts, chain state, external callback acceptance or candidate readiness. Complete those checks after the implementation merges and a candidate is approved.
