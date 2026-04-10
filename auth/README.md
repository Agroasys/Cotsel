# Auth Service

Non-custodial identity and session management for the Agroasys settlement protocol.

## Responsibility

This service is the Cotsel session boundary.

In the Agroasys-integrated production model:

- Agroasys auth is the primary end-user identity authority
- Cotsel auth exchanges trusted upstream identity for a Cotsel session
- bearer session lifecycle stays in this service

The older wallet-signature login path still exists only as a compatibility flow for local development and test environments. It is disabled by default outside those environments because the current challenge store is process-local and not horizontally safe.

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
│   │   ├── controller.ts                # Compatibility facade for split controllers
│   │   ├── controllerSupport.ts
│   │   ├── legacyWalletAuthController.ts
│   │   ├── routes.ts                    # Express router
│   │   └── sessionController.ts
│   ├── config.ts                        # Env-driven config
│   ├── core
│   │   ├── challengeStore.ts            # In-memory one-time login nonces
│   │   ├── profileStore.ts              # UserProfile store interface + Postgres impl
│   │   ├── sessionService.ts            # Login / trusted issue / refresh / revoke / resolve
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

## Legacy Compatibility Flow

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

This is not the target production architecture for Agroasys-integrated deployments. Treat it as development/test-only unless the challenge store is replaced with a horizontally safe persistent store.

## Session Lifecycle

| Endpoint | Method | Auth required |
|---|---|---|
| `/api/auth/v1/challenge` | GET | None, rate-limited, only when `LEGACY_WALLET_LOGIN_ENABLED=true` in `development` or `test` |
| `/api/auth/v1/login` | POST | Wallet signature compatibility flow, disabled outside `development` and `test` |
| `/api/auth/v1/session/exchange/agroasys` | POST | Trusted upstream service auth |
| `/api/auth/v1/session` | GET | Bearer session token |
| `/api/auth/v1/session/refresh` | POST | Bearer session token |
| `/api/auth/v1/session/revoke` | POST | Bearer session token |
| `/api/auth/v1/health` | GET | None |

## Role Model

| Role | Identity source | Notes |
|---|---|---|
| `buyer` | Trusted upstream session or compatibility wallet session | Creates trades, opens disputes |
| `supplier` | Trusted upstream session or compatibility wallet session | Passive recipient |
| `admin` | Trusted upstream session or compatibility wallet session | Governance |
| `oracle` | Service key | Relayed by oracle service, not a user session |

## Configuration

See [`env/auth.env.example`](../env/auth.env.example) for all required variables.

## License

Apache-2.0. See [LICENSE](LICENSE).
