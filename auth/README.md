# Auth Service

Non-custodial identity and session management for the Agroasys settlement protocol.

## Responsibility

This service is the **first-class identity layer** for end-user participants (buyers, suppliers, admins). It bridges Web3Auth wallet addresses to internal user profiles, and manages the full session lifecycle (issue → refresh → revoke).

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
│   ├── auth
│   │   └── serviceAuth.ts      # Wrapper around @agroasys/shared-auth
│   ├── config.ts               # Env-driven config
│   ├── core
│   │   ├── profileStore.ts     # UserProfile store interface + Postgres impl
│   │   ├── sessionService.ts   # login / refresh / revoke / resolve
│   │   └── sessionStore.ts     # UserSession store interface + Postgres impl
│   ├── database
│   │   ├── connection.ts       # pg Pool
│   │   ├── migrations.ts       # schema.sql runner
│   │   ├── queries.ts          # raw SQL helpers
│   │   └── schema.sql          # user_profiles, user_sessions, auth_hmac_nonces
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

## Identity Flow

```
Browser (Web3Auth SDK)
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

## Session Lifecycle

| Endpoint                          | Method | Auth required              |
|-----------------------------------|--------|----------------------------|
| `/api/auth/v1/challenge`          | GET    | None (rate-limited)        |
| `/api/auth/v1/login`              | POST   | Wallet signature (ECDSA)   |
| `/api/auth/v1/session`            | GET    | Bearer session token       |
| `/api/auth/v1/session/refresh`    | POST   | Bearer session token       |
| `/api/auth/v1/session/revoke`     | POST   | Bearer session token       |
| `/api/auth/v1/health`             | GET    | None                       |

## Role Model

| Role     | Identity source | Notes |
|----------|----------------|-------|
| `buyer`    | Web3Auth wallet | Creates trades, opens disputes |
| `supplier` | Web3Auth wallet | Passive recipient |
| `admin`    | Web3Auth wallet | Governance |
| `oracle`   | Service key     | Relayed by oracle service, not a user session |

## Configuration

See [`env/auth.env.example`](../env/auth.env.example) for all required variables.


## License

Apache-2.0. See [LICENSE](LICENSE).
