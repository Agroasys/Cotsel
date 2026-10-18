# Dormant user-action execution foundation

This document describes internal engineering behavior for Gateway maintainers. It does not authorize execution or change the production activation decision.

The HTTP user-action route, workflow, and both public custody entry points still deny execution unconditionally. The internal engine is exercised directly by controlled local tests. It is not wired to those execution entry points, exported by the SDK, or selectable through runtime configuration. The owner-authenticated inventory read is wired independently and remains available when issuance is disabled.

## Authority and persistence

The engine supports exactly `finalize_after_inspection_acceptance`, `cancel_locked_timeout`, and `refund_in_transit_timeout`. It rejects `open_dispute` and supplier deadline finalization before creating authority. It preserves the immutable handoff, original EIP-712 authorization, funded participants, amounts, and recipients.

Migration 016 adds immutable accepted request identity, current authorization-nonce ownership, append-only claim/signing/hash events, and retirement history. Owner plus operation and owner plus package remain permanently unique. Historical authorization nonces do not remain permanently unique: a successor needs independently verified retirement of the prior owner and must retain that history.

An accepted request stores hashes of the exact signed request, not its authorization signature. A pre-sign restart can resume only after the exact request is resupplied, with the same stable operation, nonce, deadline, and signature fingerprint. This is resupply recovery, not autonomous replay. The backend resupply adapter and execution-entry wiring remain engineering work.

A pre-sign lease has a fencing token. The irreversible `signing` marker commits atomically with its audit event before any signer invocation. A stale token cannot mark signing. After that marker, retries only observe retained evidence. A missing signer response remains quarantined even if no hash is available. Neither lease expiry nor transaction revert permits another signing attempt.

Both controlled custody implementations reserve the relayer nonce before signing. They validate the complete signed intent, retain the canonical unsigned identity and hash, and persist the existing transaction outcome before one submission. Signed bytes and authorization signatures remain transient. Existing enabled raw create-trade behavior is unchanged.

## Canonical preflight and nonce reuse

RPC, signature verification, and simulation occur outside database transactions. Acceptance and signing compare the exact immutable handoff, current nonce inventory, attempt/outcome history, approved owner, and original verification-start freshness under locks. A slow verification cannot refresh its start timestamp. Missing, expired, changed, or ambiguous evidence blocks progression.

The mandatory internal retirement port receives the exact predecessor identity, funding fingerprint, inventory fingerprint, and previously accepted retirement anchors/outcomes. Its owning-domain implementation must independently verify those retained anchors, the current finalized anchor, actual shared escrow authorization nonce, and original financial obligation. The finalized timestamp must be strictly greater than the inclusive authorization deadline. An Oracle winner needs an actual finalized payout and financial evidence; independently resolved non-execution has no invented payout transaction hash.

Every later successor progression revalidates its predecessor retirements. A contradiction appends drift and blocks further automatic progression. Local expiry, absent transactions, advanced relayer nonce, or unresolved signing/broadcast evidence cannot establish non-execution. The authenticated backend proof adapter is not implemented in this foundation; no default approval exists.

## Observation and restart recovery

The internal signed-identity recovery step materializes only a known original immutable identity into the existing outcome model. The existing reconciler and settlement observer can then recover its projection. They cannot sign, submit, substitute a competing provider hash, or create replacement transactions. The recovery step is explicit and is not added to enabled generic outcome-store consumers or wired into the production worker in this batch.

The read-only operation endpoint is `GET /settlement/gasless-executions/user-action/operations/{sourceOperationId}`. Existing service HMAC authentication determines the owner. The route accepts a canonical operation UUID and no query overrides. Missing and foreign operations return the same 404. A 404 does not prove non-execution.

The response contains a bounded immutable binding, request and binding fingerprints, handoff identity, retained attempt hashes, canonical unsigned transaction identities, and existing outcome/finality evidence. It excludes authorization signatures, calldata bytes, signed bytes, lease tokens, and provider diagnostics. Malformed or oversized persisted evidence fails closed. The inventory fingerprint binds the exact request inventory used by the retirement proof port.

## Verification limits

Local PostgreSQL tests use the real versioned migration runner, service-isolated runtime roles, separate connections and actual lock contention. Controlled chain/funding/finality/signer ports test all three actions and both raw and managed custody with real local signatures. They do not prove deployed provider custody, production role configuration, external-chain behavior, process-kill recovery, or independent financial-policy acceptance.

Remaining source integration includes the authenticated backend retirement producer/consumer adapter, exact backend resupply, guarded production execution adapters with a user-action-specific result contract, and dormant worker scheduling. Migration 016 serializes existing outcome/reconciliation writes only when they reference a new lifecycle request; unrelated historical funding and direct-send outcomes remain unchanged. Activation, governed dispute/commercial policy, provider/infrastructure acceptance, and live rehearsal remain separate gates. None is enabled by this implementation.
