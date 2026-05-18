FROM node:20-alpine AS builder
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

RUN apk add --no-cache python3 make g++

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY notifications notifications
COPY reconciliation reconciliation
COPY sdk sdk
COPY shared-db shared-db

RUN pnpm --filter @agroasys/sdk run build \
  && pnpm --filter @agroasys/notifications run build \
  && pnpm --filter reconciliation run build

FROM node:20-alpine AS runtime
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

RUN apk add --no-cache python3 make g++

RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm store prune

COPY --from=builder /app/notifications/dist /app/notifications/dist
COPY --from=builder /app/sdk/dist /app/sdk/dist
COPY --from=builder /app/shared-db /app/shared-db
COPY --from=builder /app/reconciliation/dist /app/reconciliation/dist
COPY --from=builder /app/reconciliation/src/database/schema.sql /app/reconciliation/src/database/schema.sql

RUN addgroup -S agro && adduser -S agro -G agro \
  && chown -R agro:agro /app

USER agro

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node reconciliation/dist/healthcheck.js

CMD ["node", "reconciliation/dist/cli.js", "daemon"]
