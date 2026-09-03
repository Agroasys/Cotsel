FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
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

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
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
