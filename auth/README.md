# Auth Service

Non-custodial identity and session management for the Agroasys settlement protocol.

## Responsibility

This service currently manages a **wallet-signed compatibility session flow** for Cotsel-local integrations. In the Agroasys-integrated product model, Agroasys auth is the primary end-user identity authority and Cotsel auth becomes a compatibility or bridge layer until account-first session exchange replaces this legacy wallet-first contract.

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
│   │   ├── controller.ts       # Login / session HTTP handlers
│   │   └── routes.ts           # Express router
│   ├── config.ts               # Env-driven config
│   ├── core
│   │   ├── challengeStore.ts   # In-memory one-time login nonces
│   │   ├── profileStore.ts     # UserProfile store interface + Postgres impl
│   │   ├── sessionService.ts   # login / refresh / revoke / resolve
│   │   └── sessionStore.ts     # UserSession store interface + Postgres impl
│   ├── database
│   │   ├── connection.ts       # pg Pool
│   │   ├── migrations.ts       # schema.sql runner
│   │   ├── queries.ts          # raw SQL helpers
│   │   └── schema.sql          # user_profiles, user_sessions
│   ├── metrics
│   │   └── counters.ts         # In-process event counters
│   ├── middleware
│   │   └── middleware.ts       # Session Bearer middleware + role guard
│   ├── server.ts               # Bootstrap
│   └── utils
│       └── logger.ts           # Structured JSON logger
└── tests
    ├── controller.test.ts
    ├── middleware.test.ts
    └── sessionService.test.ts
```

## Current Compatibility Identity Flow

```
Browser / signer-capable client
  1. GET  /api/auth/v1/challenge?wallet=0x...
         ← { message: "Sign in to Agroasys\nWallet: 0x...\nNonce: <hex>" }
  2. signer.signMessage(message)
         ← signature (proves the user owns this wallet — no secret key needed)
  3. POST /api/auth/v1/login { walletAddress, signature, role }
         ← server verifies signature with ethers.verifyMessage()
         ← UserProfile upserted (idempotent)
         ← UserSession issued → { sessionId, expiresAt }
  4. All subsequent calls carry: Authorization: Bearer <sessionId>
```

This is a compatibility flow, not the target long-term product architecture for Agroasys-integrated deployments.

## Session Lifecycle

| Endpoint                          | Method | Auth required              |
|-----------------------------------|--------|----------------------------|
| `/api/auth/v1/challenge`          | GET    | None (rate-limited)        |
| `/api/auth/v1/login`              | POST   | Wallet signature (ECDSA, compatibility path)   |
| `/api/auth/v1/session`            | GET    | Bearer session token       |
| `/api/auth/v1/session/refresh`    | POST   | Bearer session token       |
| `/api/auth/v1/session/revoke`     | POST   | Bearer session token       |
| `/api/auth/v1/health`             | GET    | None                       |

## Current Compatibility Role Model

| Role     | Identity source | Notes |
|----------|----------------|-------|
| `buyer`    | Wallet-backed compatibility session | Creates trades, opens disputes |
| `supplier` | Wallet-backed compatibility session | Passive recipient |
| `admin`    | Wallet-backed compatibility session | Governance |
| `oracle`   | Service key     | Relayed by oracle service, not a user session |

## Configuration

See [`env/auth.env.example`](../env/auth.env.example) for all required variables.


## License

Apache-2.0. See [LICENSE](LICENSE).
