FROM node:20-bookworm-slim AS builder
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

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY notifications notifications
COPY oracle oracle
COPY sdk sdk
COPY shared-db shared-db
COPY shared-edge shared-edge
COPY shared-http shared-http

RUN pnpm --filter @agroasys/sdk run build \
  && pnpm --filter @agroasys/notifications run build \
  && pnpm --filter oracle run build

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

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm store prune

COPY --from=builder /app/notifications/dist /app/notifications/dist
COPY --from=builder /app/sdk/dist /app/sdk/dist
COPY --from=builder /app/shared-db /app/shared-db
COPY --from=builder /app/shared-edge /app/shared-edge
COPY --from=builder /app/shared-http /app/shared-http
COPY --from=builder /app/oracle/dist /app/oracle/dist
COPY --from=builder /app/oracle/src/database/schema.sql /app/oracle/src/database/schema.sql

RUN groupadd --system agro \
  && useradd --system --gid agro --create-home agro \
  && chown -R agro:agro /app

USER agro

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;fetch('http://127.0.0.1:'+p+'/api/oracle/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["node", "oracle/dist/server.js"]
