# Dormant user-action execution foundation

This document describes internal engineering behavior for Gateway maintainers. It does not authorize execution or change the production activation decision.

The HTTP user-action route, workflow, and both public custody entry points still deny execution unconditionally. The owning factory, workflow, and both custody adapters now call the internal engine after those guards. Controlled tests exercise the internal adapters and replace guards only within Jest. The engine is not exported by the SDK or selectable through runtime configuration. The owner-authenticated inventory read is wired independently and remains available when issuance is disabled.

## Authority and persistence

The engine supports exactly `finalize_after_inspection_acceptance`, `cancel_locked_timeout`, and `refund_in_transit_timeout`. It rejects `open_dispute` and supplier deadline finalization before creating authority. It preserves the immutable handoff, original EIP-712 authorization, funded participants, amounts, and recipients.

Migration 016 adds immutable accepted request identity, current authorization-nonce ownership, append-only claim/signing/hash events, and retirement history. Owner plus operation and owner plus package remain permanently unique. Historical authorization nonces do not remain permanently unique: a successor needs independently verified retirement of the prior owner and must retain that history.

An accepted request stores hashes of the exact signed request, not its authorization signature. A pre-sign restart can resume only after the exact request is resupplied, with the same stable operation, nonce, deadline, and signature fingerprint. This is resupply recovery, not autonomous replay. The Cotsel adapters require exact resupply before signing. The paired backend implements guarded exact resupply for authenticated accepted pre-sign operations, with the same immutable body and idempotency key. It excludes signing or unresolved identities.

A pre-sign lease has a fencing token. The irreversible `signing` marker commits atomically with its audit event before any signer invocation. A stale token cannot mark signing. After that marker, retries only observe retained evidence. A missing signer response remains quarantined even if no hash is available. Neither lease expiry nor transaction revert permits another signing attempt.

Both controlled custody implementations reserve the relayer nonce before signing. They validate the complete signed intent, retain the canonical unsigned identity and hash, and persist the existing transaction outcome before one submission. Signed bytes and authorization signatures remain transient. Existing enabled raw create-trade behavior is unchanged.

## Guarded adapters and replay contract

The owning adapters reuse relayer queue locks, capacity policy, custody limits, nonce reservations, and finality verification. They revalidate original funding after queue wait and immediately before signing. Missing retirement transport blocks new authority before funding verification.

The user-action result uses `cotsel.user-action-execution.v1`. It returns the stable accepted Cotsel `requestId`, source operation, package, handoff, exact request fingerprint, signing status, and bounded attempt/outcome summaries. Its `transactionHash` is only the retained original signed identity. Provider and replacement hashes remain observations and cannot substitute for that identity.

After the irreversible signing marker, exact owner-authenticated replay can return retained evidence despite historical expiry or unavailable fresh funding RPC. It still verifies the original immutable binding, signature fingerprint, and request body. Changed body or owner cannot replay. This observation path cannot reserve a nonce, invoke a signer, or broadcast.

The retirement consumer sends `POST /api/v1/settlement-handoffs/cotsel/lifecycle-action-retirement-evidence` with `{scope}`. Existing service HMAC signs the exact method, path, query, and body. The response must contain the backend data envelope with `verified` evidence or an explicit `unavailable` or `contradicted` status. A 404 or outage never proves non-execution.

## Canonical preflight and nonce reuse

RPC, signature verification, and simulation occur outside database transactions. Acceptance and signing compare the exact immutable handoff, current nonce inventory, attempt/outcome history, approved owner, and original verification-start freshness under locks. A slow verification cannot refresh its start timestamp. Missing, expired, changed, or ambiguous evidence blocks progression.

The mandatory internal retirement port receives the exact predecessor identity, funding fingerprint, inventory fingerprint, and previously accepted retirement anchors/outcomes. Its owning-domain implementation must independently verify those retained anchors, the current finalized anchor, actual shared escrow authorization nonce, and original financial obligation. The finalized timestamp must be strictly greater than the inclusive authorization deadline. An Oracle winner needs an actual finalized payout and financial evidence; independently resolved non-execution has no invented payout transaction hash.

Every later successor progression revalidates its predecessor retirements. A contradiction appends drift and blocks further automatic progression. Local expiry, absent transactions, advanced relayer nonce, or unresolved signing/broadcast evidence cannot establish non-execution. The Cotsel consumer signs an explicit HTTPS request to the owning backend evidence endpoint with existing callback credentials. It rejects mismatched scope, malformed proof, unavailable responses, and transport failures. Gateway bootstrap resolves an explicit optional endpoint and owning-service configuration pair and passes it to the factory. Missing or malformed configuration, or missing existing callback credentials, leaves this capability unavailable. Other observation and funding behavior remains available. No default approval exists.

## Explicit retirement dependency configuration

`GATEWAY_USER_ACTION_RETIREMENT_EVIDENCE_URL` must contain an HTTPS URL with the exact path `/api/v1/settlement-handoffs/cotsel/lifecycle-action-retirement-evidence`. User information, query parameters, fragments, and alternate paths are rejected. `GATEWAY_USER_ACTION_RETIREMENT_OWNING_SERVICE_ID` must contain the explicit authenticated service owner. The server does not derive either value from callback URLs, service keys, or platform labels.

Both values and the existing callback API key and secret are required to resolve this dependency. Incomplete or malformed configuration disables the affected lifecycle capability and emits a generic reason when configuration was supplied. It does not enable actions or change the existing callback configuration requirements. No new activation flag exists. The strict runtime schema accepts older profiles that omit exactly these two optional keys by supplying empty values. Every other required-key, unknown-key and inherited-override rule remains unchanged. Compose forwards the pair with empty defaults; no deployed profile or Terraform configuration is changed.

## Observation and restart recovery

The internal signed-identity recovery step materializes only a known original immutable identity into the existing outcome model. The existing reconciler and settlement observer can then recover its projection. They cannot sign, submit, substitute a competing provider hash, or create replacement transactions. The server-owned existing outcome runtime repairs at most 25 retained lifecycle identities before its existing reconciliation cycle. Its single timer and cycle fence prevent overlapping runs. It has no signer or broadcast port. Repair failure leaves unresolved lifecycle authority intact and logs only a safe reason; existing funding and direct-send observations continue. Scoped internal/test composition uses the same runtime, without another observer loop. Service validation and migration 016 guards reject malformed signed identities from ordinary writers. A corrupted retained identity is not silently skipped: repair remains unresolved and requires investigation, while existing outcome observation continues.

The read-only operation endpoint is `GET /settlement/gasless-executions/user-action/operations/{sourceOperationId}`. Existing service HMAC authentication determines the owner. The route accepts a canonical operation UUID and no query overrides. Missing and foreign operations return the same 404. A 404 does not prove non-execution.

The response contains a bounded immutable binding, request and binding fingerprints, handoff identity, retained attempt hashes, canonical unsigned transaction identities, and existing outcome/finality evidence. It excludes authorization signatures, calldata bytes, signed bytes, lease tokens, and provider diagnostics. Malformed or oversized persisted evidence fails closed. The inventory fingerprint binds the exact request inventory used by the retirement proof port.

## Verification limits

Local PostgreSQL tests use the real versioned migration runner, service-isolated runtime roles, separate connections and actual lock contention. Controlled chain/funding/finality/signer ports test all three actions and both raw and managed custody with real local signatures. They do not prove deployed provider custody, production role configuration, external-chain behavior or independent financial-policy acceptance. Separate controlled SIGKILL tests cover selected signing-marker, signed-identity/outcome-write and HTTP pre-sign claim boundaries; they do not establish every crash boundary or deployed process recovery.

Remaining integration includes a complete controlled two-service HTTP/TLS/authentication scenario, independently accepted backend retirement evidence, and deployed runtime verification. The paired backend provides source-gated resupply and strict lifecycle result validation. Independently resolved non-execution remains unsupported until its authoritative owning resolution exists. Guarded adapters and a user-action-specific result contract are implemented; every public execution call still stops at its hard denial. Migration 016 serializes existing outcome/reconciliation writes only when they reference a new lifecycle request; unrelated historical funding and direct-send outcomes remain unchanged. Activation, governed dispute/commercial policy, provider/infrastructure acceptance, and live rehearsal remain separate gates. None is enabled by this implementation.
