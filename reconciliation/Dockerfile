FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json .npmrc ./
COPY shared-db/package.json shared-db/package.json
COPY notifications notifications
COPY sdk sdk
COPY shared-db shared-db
COPY reconciliation reconciliation

RUN apk add --no-cache python3 make g++

RUN npm ci

RUN npm run -w @agroasys/notifications build \
  && npm run -w @agroasys/sdk build \
  && npm run -w reconciliation build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json .npmrc ./
COPY reconciliation/package.json reconciliation/package.json
COPY sdk/package.json sdk/package.json
COPY notifications/package.json notifications/package.json
COPY shared-db/package.json shared-db/package.json

RUN apk add --no-cache python3 make g++

RUN npm pkg delete scripts.prepare --workspace @agroasys/notifications || true

RUN npm ci --omit=dev --ignore-scripts \
  --workspace @agroasys/notifications \
  --workspace @agroasys/sdk \
  --workspace @agroasys/shared-db \
  --workspace reconciliation \
  --include-workspace-root=false \
  && npm cache clean --force

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
