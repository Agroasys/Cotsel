# Gateway Downstream Service Contracts

Snapshot date: 2026-04-28

## Purpose

This document records the gateway-owned consumer contracts for downstream
services. It is intentionally small: the goal is to catch incompatible response
shape or authority drift early without introducing a separate contract-testing
platform.

## Contract Rules

### `gateway -> auth`

Gateway treats `/api/auth/v1/session` as the authority source for account,
role, capability, and signer-binding truth.

Required successful response:

- `success: true`
- `data.userId`
- `data.walletAddress` as a string or `null`
- `data.role` as one of `buyer`, `supplier`, `admin`, `oracle`
- `data.capabilities` as an array of known operator capability strings
- `data.signerAuthorizations` as an array of known signer bindings
- `data.issuedAt` and `data.expiresAt` as finite numbers

Gateway must fail closed when this shape drifts because route authorization,
treasury permissions, and signer-policy checks depend on these fields.

Validation:

- `gateway/tests/authSessionClient.test.ts`
- `gateway/tests/authMiddleware.test.ts`

### `gateway -> treasury`

Gateway treats treasury internal APIs as response-envelope contracts.

Required successful response:

- `success: true`
- `data` present
- mutation `data` must be a JSON object/record, not an array or scalar

Required error response fields used by gateway:

- `error.code`
- `error.message`
- optional `error.details`

Gateway maps `404` to `NOT_FOUND`, `409` to `CONFLICT`, validation failures to
`VALIDATION_ERROR`, and other upstream failures to `UPSTREAM_UNAVAILABLE`.

Validation:

- `gateway/tests/treasuryWorkflowService.test.ts`
- `gateway/tests/treasuryRoutes.contract.test.ts`

### `gateway -> ricardian`

Gateway consumes `/api/ricardian/v1/hash/:hash` as a document lookup contract.

Required successful document fields:

- `hash`
- `documentRef`
- `requestId`
- `createdAt`

Gateway preserves `404` as not-found and fails closed on invalid successful
payloads.

Validation:

- `gateway/tests/ricardianClient.test.ts`
- `gateway/tests/ricardianRoutes.contract.test.ts`

### `gateway -> indexer`

Gateway consumes indexer GraphQL trade and overview snapshots for dashboard
trade reads.

Required response fields:

- `data.trades` as an array
- `data.overviewSnapshotById.lastIndexedAt`
- `data.overviewSnapshotById.lastProcessedBlock`
- `data.overviewSnapshotById.lastTradeEventAt`
- trade records with known status, ISO timestamps, and parseable raw USDC
  amounts

Gateway must reject unknown trade status values, invalid timestamps, invalid raw
amounts, and missing freshness snapshots.

Validation:

- `gateway/tests/tradeReadService.test.ts`
- `gateway/tests/tradeRoutes.contract.test.ts`

### `gateway -> reconciliation`

Current dashboard reconciliation reads are gateway-ledger backed. The runtime
service boundary that gateway actively depends on today is reconciliation
health/readiness through compose and operations checks.

Validation:

- `gateway/tests/reconciliationReadService.test.ts`
- `gateway/tests/reconciliationRoutes.contract.test.ts`
- `scripts/docker-services.sh health <profile>`

## Non-Goals

- No generic consumer-driven-contract framework.
- No duplicate schema registry.
- No broad service communication rewrite.
- No production claims beyond the contracts and tests above.
