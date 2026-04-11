# Indexer

This module indexes **AgroasysEscrow** EVM logs from **Base Sepolia** and **Base Mainnet** into a queryable PostgreSQL datastore (TypeORM) and exposes a read-only GraphQL API for the rest of the platform.

---

## What this indexer does

### Core responsibilities

- **Ingest escrow contract logs** from the configured Base settlement runtime.
- **Persist** normalized trade state + event history into Postgres (TypeORM models generated from `schema.graphql`).
- Provide a **read-only GraphQL interface** for the platform backend to query:
  - trades, participants, amounts, statuses
  - settlement milestones
  - dispute lifecycle and approvals
  - event timeline / audit trail
- Ensure indexing is:
  - **Idempotent** (replays do not duplicate rows or double-count amounts)
  - **Re-org safe** (EVM log identity is stable and replay-safe)
  - **Config-driven** (runtime, start block, and finality confirmation come from env/config)

### Events indexed (must match the on-chain contract)

The indexer is expected to capture and store the following escrow events:

- `TradeLocked`
- `FundsReleasedStage1`
- `PlatformFeesPaidStage1`
- `ArrivalConfirmed`
- `FinalTrancheReleased`
- `DisputeOpenedByBuyer`
- `DisputeSolutionProposed`
- `DisputeApproved`
- `DisputeFinalized`
- `OracleUpdateProposed`
- `OracleUpdateApproved`
- `OracleUpdated`
- `AdminAddProposed`
- `AdminAddApproved`
- `AdminAdded`

> Note: If the contract changes event names/arguments, update:
>
> - the ABI/event decoder
> - `schema.graphql` types
> - mappings/handlers
> - this README’s event list

---

## Security & correctness requirements

### Configuration rules

- **No hardcoded RPC endpoints** or API keys.
- Use environment variables (`.env`) and validate configuration at startup.
- Use **approved/whitelisted endpoints only** (internal RPC or approved providers).
- Enforce **explicit block range limits** to avoid unbounded historical queries.

### Data integrity rules

- Writes must be **atomic and retry-safe**.
- Event handlers must:
  - validate the **expected contract address**
  - verify the **expected contract address**
  - decode only the frozen Base-era escrow ABI
  - enforce **deterministic primary keys** (`txHash + logIndex`) to guarantee idempotency

### Re-org handling

- Must handle chain **re-orgs** using deterministic event identity and configured confirmation depth.
- Avoid assumptions of immediate finality; active downstream workflow and treasury gates rely on Base `safe` and `finalized` stages.

---

## Suggested directory layout

```text
indexer/
├── db/
├── src/
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── docker-compose.yml
├── package.json
├── schema.graphql
├── tsconfig.json
```

### Validation checklist

- Schema enforces strict types (no any equivalents).
- Event handlers verify the expected contract address and event types.
- Inserts/updates are idempotent and replay-safe.
- Re-org rollback behavior is deterministic and tested.
- GraphQL is read-only (no mutations).
- No secrets / endpoints are hardcoded in code.

---

### Local Dev

#### Prerequisites

- Node.js + npm
- Docker + Docker Compose
- A reachable Base RPC endpoint for the target environment
- A deployed AgroasysEscrow contract address + deployment start block
- .env configured (see below)

#### Install and generate models/migrations

```
npm install

# generate TypeORM models from schema.graphql
npx squid-typeorm-codegen

# start the db container
docker compose up -d db

# generate migrations
rm -rf db/migrations
npx squid-typeorm-migration generate

# apply the migrations
npx squid-typeorm-migration apply
```

#### Build and run

```
# compile the code
npm run build

# run the indexer
node -r dotenv/config lib/main.js
```

---

### Updating `schema.graphql`

When you edit `schema.graphql`, you must re-generate models and migrations:

```
npx squid-typeorm-codegen

rm -rf db/migrations

npx squid-typeorm-migration generate

npx squid-typeorm-migration apply

npm run build
node -r dotenv/config lib/main.js
```

---

### Running the indexer in Docker

```
# generate TypeORM models
npx squid-typeorm-codegen

# start the db
docker compose up -d db

# regenerate migrations
rm -r db/migrations
npx squid-typeorm-migration generate

# apply migrations inside the container context
docker compose run --rm indexer npx squid-typeorm-migration apply

# start everything
docker compose up -d

# follow logs
docker compose logs -f
```

---

### Operational notes

1. Always confirm the GraphQL endpoint and RPC point to the same Base runtime.
2. If you see missing blocks / “Failed to fetch block …” errors:
   - confirm your start block exists in the configured Base dataset
   - confirm your gateway URL matches the deployed Base runtime
   - reduce RPC rate limits if your provider is throttling

3. If events appear in the configured Base explorer but not in the indexer:
   - confirm the processor event filters match the emitted event names
   - confirm the ABI/decoder matches the deployed contract build
   - confirm contract address filtering is correct

---

### GraphQL API

The indexer exposes a GraphQL endpoint for read-only queries. Use it from the backend to retrieve:

- Trade lifecycle state (LOCKED → IN_TRANSIT → ARRIVAL_CONFIRMED → CLOSED/FROZEN)
- Milestone settlements (stage 1 releases and final tranche)
- Dispute proposals, approvals, and final outcomes
- Full event timelines for audits

> Do not expose write/mutation operations from this indexer.

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
