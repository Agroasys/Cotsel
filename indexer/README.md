# Indexer

Indexes **AgroasysEscrow** events from Base into Postgres (TypeORM) and exposes a read-only GraphQL API.

---

## Initial setup

```bash
# From Cotsel/ (monorepo root)
pnpm install --frozen-lockfile

# Start the database
docker compose up -d db

# Compile then apply existing migrations
pnpm run build
pnpm exec squid-typeorm-migration apply
```

---

## After changing `schema.graphql`

Only run `codegen` and `generate` when you actually edit `schema.graphql`. Do NOT run them on a first-time setup — the existing migrations in `db/migrations/` already cover the full schema.

```bash
# 1. Regenerate TypeORM entities
pnpm exec squid-typeorm-codegen

# 2. Compile (migration tool reads from lib/, not src/)
pnpm run build

# 3. Generate a new incremental migration
pnpm exec squid-typeorm-migration generate

# 4. Apply it
pnpm exec squid-typeorm-migration apply

# 5. Restart
node -r dotenv/config lib/main.js
```

## After changing handlers / ABI only (no schema change)

```bash
pnpm run build
node -r dotenv/config lib/main.js
```

> **Warning:** running `generate` against an empty DB will produce a "create everything" migration that conflicts with the existing ones. Always apply existing migrations first, then generate on top.

---

## Generated model policy

Files under `src/model/generated/` must remain the direct output of the official `squid-typeorm-codegen` command. Do not hand-edit or post-process generated models. Treat changes to entity or index decorators as schema metadata changes and review them together with the corresponding generated migration.

`@subsquid/typeorm-codegen` 2.4.0 currently emits an unused `Column_` import for entities that do not use the generic column decorator. This produces six known CodeQL findings:

- `overviewSnapshot.model.ts`
- `systemEvent.model.ts`
- `oracleEvent.model.ts`
- `oracleUpdateProposal.model.ts`
- `adminEvent.model.ts`
- `adminAddProposal.model.ts`

These findings are tracked upstream in [subsquid/squid-sdk#547](https://github.com/subsquid/squid-sdk/issues/547). They may be dismissed as documented generated-code findings while the upstream issue remains open; do not suppress CodeQL coverage for the rest of the indexer.

---

## Command reference

| Command                                      | Description                                       |
| -------------------------------------------- | ------------------------------------------------- |
| `pnpm exec squid-typeorm-codegen`            | Regenerate TypeORM entities from `schema.graphql` |
| `pnpm exec squid-typeorm-migration generate` | Generate a new incremental migration              |
| `pnpm exec squid-typeorm-migration apply`    | Apply pending migrations                          |
| `pnpm run build`                             | Compile TypeScript                                |
| `pnpm run typecheck`                         | Type-check without compiling                      |
| `pnpm run lint`                              | Run linter                                        |
| `pnpm run test`                              | Run tests                                         |
| `docker compose up -d db`                    | Start Postgres                                    |
| `docker compose logs -f`                     | Tail logs                                         |
