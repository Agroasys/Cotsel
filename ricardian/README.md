# Ricardian Service v0

Deterministic canonicalization and SHA-256 hashing service for Ricardian payloads.

## Endpoints

- `POST /api/ricardian/v1/hash` (optional `tenantId`, bound to the authenticated principal)
- `GET /api/ricardian/v1/hash/:hash` (minimal public attestation)
- `GET /api/ricardian/v1/hash/:hash/document[?tenantId=<tenant>]` (complete document, owning tenant only)
- `GET /api/ricardian/v1/health`
- `GET /api/ricardian/v1/ready`

Tenant boundary:

- The tenant is derived from the verified service-auth principal (`req.serviceAuth.apiKeyId`),
  never from the request alone. Without `tenantId`, a caller registers and reads as its own key
  id. A caller may name a different tenant only when its key id is listed in
  `TENANT_DELEGATION_API_KEYS`; any other caller gets `403 TenantMismatch` before any lookup. The
  named tenant is inside the HMAC-signed body or query, so it cannot be altered in transit.
- The dashboard gateway is the delegating caller: it names the platform service key id it
  authenticated. Delegation ids must be configured API keys, or startup fails. With
  `AUTH_ENABLED=false` (local only) the tenant must be named explicitly.
- The tenant is stored with the row but is not part of the hashed canonical payload.
- `GET /hash/:hash` returns only `hash`, `rulesVersion`, and `registeredAt`. It never returns
  terms, metadata, `documentRef`, `requestId`, or the tenant.
- `GET /hash/:hash/document` returns the complete record only when the resolved tenant matches
  the registering tenant. Another tenant's document, and rows registered before the
  `tenant_binding` migration, return `404 DOCUMENT_NOT_FOUND`, identical to an unknown hash.
- Registering an existing `(hash, documentRef)` pair under a different tenant is a `409`
  conflict; the historical row is never reassigned.

Health semantics:

- `/health`: process-level liveness
- `/ready`: dependency readiness (database connectivity check)

## Service Auth (optional)

When `AUTH_ENABLED=true`, all API endpoints except `health` and `ready` require HMAC headers:

- `x-agroasys-timestamp` (unix seconds)
- `x-agroasys-signature` (HMAC-SHA256)
- `x-agroasys-nonce` (optional; deterministic fallback derived when omitted)

Optional key-based mode:

- `X-Api-Key` to select key-specific secret from `API_KEYS_JSON`
- If `X-Api-Key` is omitted, middleware can verify with `HMAC_SECRET`

Nonce replay store:

- `NONCE_STORE=redis|postgres|inmemory`
- `REDIS_URL` required when `NONCE_STORE=redis`
- `NONCE_TTL_SECONDS` controls nonce replay window (defaults to `AUTH_NONCE_TTL_SECONDS`)
- `NODE_ENV=production` rejects `NONCE_STORE=inmemory` at startup

Canonical string format:
`METHOD\nPATH\nQUERY\nBODY_SHA256\nTIMESTAMP\nNONCE`

Auth failures return structured JSON with stable `code` values (for example: `AUTH_MISSING_HEADERS`, `AUTH_INVALID_SIGNATURE`, `AUTH_FORBIDDEN`).
`API_KEYS_JSON` entries must set `active` as an explicit boolean (`true` or `false`) for each key.

## Rate Limiting (optional)

Set `RATE_LIMIT_ENABLED=true` to enforce per-route limits.

- Write route (`POST /hash`): stricter burst + sustained limits
- Read routes (`GET /hash/:hash`, `GET /hash/:hash/document`): looser burst + sustained limits
- Limiter identity:
  - authenticated write calls: `apiKey + ip`
  - unauthenticated calls: `ip` fallback
- Response includes `RateLimit-*` headers and `Retry-After` on 429

Redis-backed mode is used when `RATE_LIMIT_REDIS_URL` is configured.
In-memory fallback is allowed for local/dev environments only.

## Observability

Structured logs include baseline keys:

- `service`
- `env`

Correlation keys are emitted by call path when available:

- `tradeId`
- `actionKey`
- `requestId`
- `txHash`

## Notes

- Canonicalization rules are versioned (`RICARDIAN_CANONICAL_V1`).
- Hashes and metadata are persisted for auditability.
- Service does not perform legal interpretation.

## Docker

See `docs/cotsel-cli.md` and `docs/runbooks/runtime-stack.md` for runtime operations.

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
