# Ricardian Service v0

Deterministic canonicalization and SHA-256 hashing service for Ricardian payloads.

## Endpoints

- `POST /api/ricardian/v1/hash`
- `GET /api/ricardian/v1/hash/:hash`
- `GET /api/ricardian/v1/health`
- `GET /api/ricardian/v1/ready`

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
- Read route (`GET /hash/:hash`): looser burst + sustained limits
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

See `docs/docker-services.md` and `docs/runbooks/docker-profiles.md` for runtime operations.

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
