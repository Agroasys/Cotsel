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
