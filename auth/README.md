# Auth Service

Non-custodial identity and session management for the Agroasys settlement protocol.

## Responsibility

This service is the Cotsel session boundary.

In the Agroasys-integrated production model:

- Agroasys auth is the primary end-user identity authority
- Cotsel auth exchanges trusted upstream identity for a Cotsel session
- bearer session lifecycle stays in this service

It is **separate** from `shared-auth`, which handles service-to-service HMAC authentication.

## Files

```
.
├── Dockerfile
├── jest.config.js
├── package.json
├── tsconfig.json
├── src
│   ├── api
│   │   ├── controller.ts                # SessionController re-export barrel
│   │   ├── controllerSupport.ts
│   │   ├── routes.ts                    # Express router
│   │   └── sessionController.ts
│   ├── config.ts                        # Env-driven config
│   ├── core
│   │   ├── profileStore.ts              # UserProfile store interface + Postgres impl
│   │   ├── sessionService.ts            # Trusted issue / refresh / revoke / resolve
│   │   └── sessionStore.ts              # UserSession store interface + Postgres impl
│   ├── database
│   │   ├── connection.ts                # pg Pool
│   │   ├── migrations.json              # versioned migration manifest
│   │   ├── queries.ts                   # raw SQL helpers
│   │   └── schema.sql                   # user_profiles, user_sessions, trusted nonces
│   ├── metrics
│   │   └── counters.ts                  # In-process event counters
│   ├── middleware
│   │   └── middleware.ts                # Session bearer middleware + role guard
│   ├── server.ts                        # Bootstrap
│   └── utils
│       └── logger.ts                    # Structured JSON logger
└── tests
    ├── controller.test.ts
    ├── middleware.test.ts
    └── sessionService.test.ts
```

## Production Identity Flow

```
Agroasys platform
  1. Authenticates the operator or admin
  2. Calls POST /api/auth/v1/session/exchange/agroasys with trusted service auth
         and the normalized identity payload
         ← Cotsel issues { sessionId, expiresAt }
  3. Browser or upstream service uses Authorization: Bearer <sessionId>
  4. Cotsel session refresh / revoke / resolve stay local to this service
```

This is the primary production path.

## Session Lifecycle

| Endpoint                                 | Method | Auth required                 |
| ---------------------------------------- | ------ | ----------------------------- |
| `/api/auth/v1/session/exchange/agroasys` | POST   | Trusted upstream service auth |
| `/api/auth/v1/session`                   | GET    | Bearer session token          |
| `/api/auth/v1/session/refresh`           | POST   | Bearer session token          |
| `/api/auth/v1/session/revoke`            | POST   | Bearer session token          |
| `/api/auth/v1/health`                    | GET    | None                          |

- **Storage.** Only a SHA-256 verifier of each bearer token is persisted
  (`user_sessions.session_token_hash`); a database export cannot authenticate.
- **Refresh.** Revoking the presented session and issuing its successor happen in
  one transaction under a row lock. Each session has at most one successor
  (`parent_session_token_hash` is unique), so concurrent or replayed refreshes of
  the same token yield exactly one active session.
- **Lifetime.** `SESSION_TTL_SECONDS` bounds every issued session; an exchange
  requesting a larger or non-positive `ttlSeconds` is refused with `400`.
  `SESSION_ABSOLUTE_LIFETIME_SECONDS` bounds a whole refresh lineage from its
  first issuance; once reached, refresh fails and a new exchange is required.
- **Logging.** Routine session logs carry the internal `userId` and role only —
  never tokens, token hashes, wallet addresses, emails, or upstream account IDs.

## Role Model

| Role       | Identity source          | Notes                                         |
| ---------- | ------------------------ | --------------------------------------------- |
| `buyer`    | Trusted upstream session | Creates trades, opens disputes                |
| `supplier` | Trusted upstream session | Passive recipient                             |
| `admin`    | Trusted upstream session | Governance                                    |
| `oracle`   | Service key              | Relayed by oracle service, not a user session |

## Configuration

See [`env/auth.env.example`](../env/auth.env.example) for all required variables.

## License

Apache-2.0. See [LICENSE](LICENSE).
