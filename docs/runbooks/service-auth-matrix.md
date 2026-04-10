# Service Auth Matrix

## Purpose

Define the active authentication boundary between Cotsel services.

This is the operational source of truth for:

- which service talks to which
- what auth material is used
- where the controlling config lives
- what must never be forwarded

## Rules that always apply

- never forward dashboard bearer sessions to internal services that expect service auth
- never log service keys, HMAC secrets, bearer tokens, or raw signed canonical strings
- rotate the downstream auth material if a service boundary is suspected compromised
- production-candidate services must fail closed when required service auth is missing

## Matrix

| Caller | Callee | Purpose | Auth model | Config location |
|---|---|---|---|---|
| Agroasys upstream | `auth` | trusted session exchange | shared-auth HMAC/API-key auth | auth service env/config |
| dashboard browser | `auth` | bearer session lifecycle | Cotsel bearer session | auth HTTP contract |
| dashboard browser | `gateway` | operator/admin reads and writes | Cotsel bearer session | gateway HTTP contract |
| `gateway` | `oracle` | downstream service actions/reads | oracle bearer + HMAC contract | gateway + oracle env/config |
| `gateway` | `treasury` | ledger and payout reads/mutations | shared-auth HMAC/API-key auth | gateway + treasury env/config |
| `gateway` | `ricardian` | ricardian reads | shared-auth HMAC/API-key auth | gateway + ricardian env/config |
| settlement ingress callers | `gateway` settlement ingress | service-origin settlement handoff/callback contract | shared-auth HMAC/API-key auth | gateway env/config |
| `treasury` direct clients | `treasury` | treasury HTTP surface | shared-auth HMAC/API-key auth when enabled | treasury env/config |
| `ricardian` direct clients | `ricardian` | ricardian HTTP surface | shared-auth HMAC/API-key auth when enabled | ricardian env/config |
| direct oracle callers | `oracle` | oracle HTTP surface | oracle bearer + HMAC contract | oracle env/config |

## Canonical config references

Trusted upstream session exchange in auth:

```text
TRUSTED_SESSION_EXCHANGE_ENABLED
TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON
TRUSTED_SESSION_EXCHANGE_MAX_SKEW_SECONDS
TRUSTED_SESSION_EXCHANGE_NONCE_TTL_SECONDS
```

Gateway downstream service auth:

```text
GATEWAY_ORACLE_SERVICE_API_KEY
GATEWAY_ORACLE_SERVICE_API_SECRET
GATEWAY_TREASURY_SERVICE_API_KEY
GATEWAY_TREASURY_SERVICE_API_SECRET
GATEWAY_RICARDIAN_SERVICE_API_KEY
GATEWAY_RICARDIAN_SERVICE_API_SECRET
GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON
GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET
```

Treasury and Ricardian inbound auth:

```text
AUTH_ENABLED
API_KEYS_JSON
HMAC_SECRET
```

Oracle inbound auth:

```text
API_KEY
HMAC_SECRET
```

## Service-specific notes

### `auth`

Production path:

- trusted upstream session exchange is the primary production path
- compatibility wallet login is not the primary production path

### `gateway`

`gateway` is the auth boundary between dashboard sessions and internal service auth.

It must:

- validate the bearer session
- derive downstream service-auth headers itself
- preserve request/correlation IDs
- fail closed if downstream auth is required but absent

### `oracle`

`oracle` still uses its existing bearer + HMAC model. That contract is transitional but active.

Do not treat it as interchangeable with the shared-auth HMAC/API-key contract unless and until the service is deliberately normalized.

### `treasury` and `ricardian`

Both services now default to enabled auth in production mode and reject `NONCE_STORE=inmemory` in production.

## Header-level expectations

### Shared-auth HMAC/API-key pattern

- timestamp header
- signature header
- optional nonce header
- optional caller-selected service-key header

### Oracle pattern

- bearer authorization header
- timestamp header
- signature header

## Failure policy

- missing required service auth: fail closed
- invalid signature or nonce replay: fail closed and log the correlation metadata only
- do not retry authenticated mutations with stale signed headers
- regenerate service auth for each fresh request or replay

## Rotation triggers

Rotate service auth immediately when:

- a secret or key is exposed in logs or screenshots
- a service auth secret is copied into an unapproved env or host
- replay or misuse is suspected and the blast radius is unclear
- an engineer who held the material loses access approval or leaves the owning team

Use:

- `docs/runbooks/secrets-and-token-rotation.md`

## Related docs

- `docs/runbooks/api-gateway-boundary.md`
- `docs/runbooks/dashboard-api-gateway-boundary.md`
- `docs/runbooks/runtime-truth-deployment-guide.md`
