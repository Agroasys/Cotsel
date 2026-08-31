FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.34.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
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

ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  /app/aws-rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/aws-rds-global-bundle.pem

RUN apk upgrade --no-cache \
  && corepack enable \
  && corepack prepare pnpm@10.34.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
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
  && corepack disable \
  && rm -rf /root/.cache/node/corepack \
    /opt/yarn-v* \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/pnpm /usr/local/bin/pnpx \
  && apk del .build-deps

COPY --from=builder /app/notifications/dist /app/notifications/dist
COPY --from=builder /app/sdk/dist /app/sdk/dist
COPY --from=builder /app/shared-db /app/shared-db
COPY --from=builder /app/reconciliation/dist /app/reconciliation/dist
COPY --from=builder /app/reconciliation/src/database/schema.sql /app/reconciliation/src/database/schema.sql
COPY --from=builder /app/reconciliation/src/database/migrations.json /app/reconciliation/src/database/migrations.json

RUN addgroup -S agro && adduser -S agro -G agro \
  && chown -R agro:agro /app

USER agro

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node reconciliation/dist/healthcheck.js

CMD ["node", "reconciliation/dist/cli.js", "daemon"]
