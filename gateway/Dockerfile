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

RUN apk add --no-cache --virtual .build-deps python3 make g++

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY docs docs
COPY gateway gateway
COPY sdk sdk
COPY shared-auth shared-auth
COPY shared-db shared-db
COPY shared-edge shared-edge

RUN pnpm --filter @agroasys/sdk run build \
  && pnpm --filter gateway run build

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

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm store prune \
  && apk del .build-deps

COPY --from=builder /app/gateway/dist /app/gateway/dist
COPY --from=builder /app/gateway/src/database/schema.sql /app/gateway/src/database/schema.sql
COPY --from=builder /app/sdk/dist /app/sdk/dist
COPY --from=builder /app/shared-auth /app/shared-auth
COPY --from=builder /app/shared-db /app/shared-db
COPY --from=builder /app/shared-edge /app/shared-edge

RUN addgroup -S agro && adduser -S agro -G agro \
  && chown -R agro:agro /app

USER agro

EXPOSE 3600

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3600;fetch('http://127.0.0.1:'+p+'/api/dashboard-gateway/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["node", "gateway/dist/server.js"]
