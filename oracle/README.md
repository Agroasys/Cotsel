# Oracle Signing Service

Secure oracle service that automates blockchain transactions in the Agroasys ecosystem.

## Files

```
.
├── docker-compose.yml
├── Dockerfile
├── jest.config.js
├── package.json
├── README.md
├── src
│   ├── api
│   │   ├── controller.ts
│   │   └── routes.ts
│   ├── blockchain
│   │   ├── indexer-client.ts
│   │   └── sdk-client.ts
│   ├── config.ts
│   ├── core
│   │   ├── state-validator.ts
│   │   └── trigger-manager.ts
│   ├── database
│   │   ├── connection.ts
│   │   ├── migrations.ts
│   │   ├── queries.ts
│   │   └── schema.sql
│   ├── middleware
│   │   └── middleware.ts
│   ├── server.ts
│   ├── types
│   │   ├── api.ts
│   │   ├── config.ts
│   │   ├── index.ts
│   │   └── trigger.ts
│   ├── utils
│   │   ├── crypto.ts
│   │   ├── errors.ts
│   │   └── logger.ts
│   └── worker
│       └── confirmation-worker.ts
├── tests
│   └── oracle.test.ts
└── tsconfig.json
```

## Purpose

The oracle automatically executes trade state transitions (release funds, confirm arrival, finalize) while ensuring:

- Idempotency - No double execution
- Resilience - Automatic retries with exponential backoff
- Verification - Execution safety checks use on-chain state; indexer is for confirmation/observability

## Main Flow

1. Web2 Backend
   `POST /release-stage1`

2. Oracle API
   - Accepts caller-provided `tradeId` + `requestId`
   - Derives `action_key` from (`triggerType`, `tradeId`) and checks idempotency in DB

3. Trigger Manager
   - Validates trade state on-chain
   - Creates trigger in database

4. Retry Loop
   - Executes blockchain action via SDK
   - Applies exponential backoff on failure

5. Transaction Submitted
   - Status: `SUBMITTED`
   - Stores `tx_hash` and `block_number`

6. Confirmation Worker (polls every 10 seconds)
   - Verifies event in indexer
   - Status: `CONFIRMED`

## Trigger Statuses

- `PENDING` - Waiting to execute
- `EXECUTING` - Execution in progress
- `SUBMITTED` - Transaction sent to network
- `CONFIRMED` - Confirmed by indexer
- `EXHAUSTED_NEEDS_REDRIVE` - Max retries reached, requires redrive
- `TERMINAL_FAILURE` - Permanent failure (validation error)

## Idempotency Model

The action key represents the business identity of the operation.
The request ID is unique per execution attempt.

This design allows the system to distinguish a single business action from multiple retry attempts and prevents duplicate execution.

## Authentication

All requests require HMAC signature verification and API key.

## Endpoints

All Oracle routes are mounted under `/api/oracle`, so the full URL for each entry below looks like `POST /api/oracle/release-stage1` when the service is exposed via Docker compose or `/api/oracle/health` when probing the health endpoint.

- POST /release-stage1
- POST /confirm-arrival
- POST /finalize-trade
- POST /redrive
- GET /health
- GET /ready

## Request Contract

For `POST /release-stage1`, `POST /confirm-arrival`, and `POST /finalize-trade`:

- JSON body must include `tradeId` and `requestId`
- Headers must include:
  - `Authorization: Bearer <API_KEY>`
  - `X-Timestamp`
  - `X-Signature` (HMAC-SHA256 of `timestamp + rawBody`)

## Health and Readiness

- `GET /health` reports process liveness.
- `GET /ready` reports process readiness to serve requests.

## Observability

Structured logs include baseline keys:

- `service`
- `env`

Correlation keys are emitted when available:

- `tradeId`
- `actionKey`
- `requestId`
- `txHash`

## Environment

Copy `oracle/.env.example` to `.env` and fill in the values for each section below before starting the service:

| Variable                                                                      | Purpose                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PORT`                                                                        | HTTP listener                                                       |
| `API_KEY`, `HMAC_SECRET`                                                      | HMAC authentication secrets                                         |
| `RPC_URL`, `CHAIN_ID`, `ESCROW_ADDRESS`, `USDC_ADDRESS`, `ORACLE_PRIVATE_KEY` | Chain connection + oracle signing                                   |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`                     | Postgres configuration                                              |
| `INDEXER_GRAPHQL_URL`                                                         | Read-only backend indexer endpoint                                  |
| `RETRY_ATTEMPTS`, `RETRY_DELAY`                                               | Retry configuration for failed blockchain calls                     |
| `NOTIFICATIONS_*`                                                             | Optional notification webhooks & cooldowns listed in `.env.example` |

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
