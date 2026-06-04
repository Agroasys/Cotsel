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
│   │   ├── migrations.ts                # schema.sql runner
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
