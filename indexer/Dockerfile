FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY auth/package.json auth/package.json
COPY contracts/package.json contracts/package.json
COPY gateway/package.json gateway/package.json
COPY indexer/package.json indexer/package.json
COPY notifications/package.json notifications/package.json
COPY oracle/package.json oracle/package.json
COPY reconciliation/package.json reconciliation/package.json
COPY ricardian/package.json ricardian/package.json
COPY sdk/package.json sdk/package.json
COPY shared-auth/package.json shared-auth/package.json
COPY shared-db/package.json shared-db/package.json
COPY shared-edge/package.json shared-edge/package.json
COPY shared-http/package.json shared-http/package.json
COPY treasury/package.json treasury/package.json
COPY patches patches

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter indexer exec patch-package --patch-dir ../patches --error-on-fail

COPY indexer indexer

RUN pnpm --filter indexer run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY auth/package.json auth/package.json
COPY contracts/package.json contracts/package.json
COPY gateway/package.json gateway/package.json
COPY indexer/package.json indexer/package.json
COPY notifications/package.json notifications/package.json
COPY oracle/package.json oracle/package.json
COPY reconciliation/package.json reconciliation/package.json
COPY ricardian/package.json ricardian/package.json
COPY sdk/package.json sdk/package.json
COPY shared-auth/package.json shared-auth/package.json
COPY shared-db/package.json shared-db/package.json
COPY shared-edge/package.json shared-edge/package.json
COPY shared-http/package.json shared-http/package.json
COPY treasury/package.json treasury/package.json
COPY patches patches

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && (cd indexer && npx --yes patch-package@8.0.1 --patch-dir ../patches --error-on-fail) \
  && pnpm store prune

COPY --from=builder /app/indexer/package.json /app/indexer/package.json
COPY --from=builder /app/indexer/lib /app/indexer/lib
COPY --from=builder /app/indexer/db /app/indexer/db
COPY --from=builder /app/indexer/schema.graphql /app/indexer/schema.graphql

WORKDIR /app/indexer

CMD ["node", "-r", "dotenv/config", "lib/main.js"]
