FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY gateway/package.json gateway/package.json
COPY sdk/package.json sdk/package.json
COPY shared-auth/package.json shared-auth/package.json

RUN apk add --no-cache --virtual .build-deps python3 make g++

RUN npm ci --ignore-scripts

COPY docs docs
COPY gateway gateway
COPY sdk sdk
COPY shared-auth shared-auth

RUN npm run -w @agroasys/sdk build && npm run -w gateway build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY gateway/package.json gateway/package.json
COPY sdk/package.json sdk/package.json
COPY shared-auth/package.json shared-auth/package.json

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci --omit=dev --ignore-scripts --workspace gateway --workspace @agroasys/sdk --workspace @agroasys/shared-auth --include-workspace-root=false \
  && npm cache clean --force \
  && apk del .build-deps

COPY --from=builder /app/gateway/dist /app/gateway/dist
COPY --from=builder /app/gateway/src/database/schema.sql /app/gateway/src/database/schema.sql
COPY --from=builder /app/sdk/dist /app/sdk/dist
COPY --from=builder /app/shared-auth /app/shared-auth

RUN addgroup -S agro && adduser -S agro -G agro \
  && chown -R agro:agro /app

USER agro

EXPOSE 3600

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3600;fetch('http://127.0.0.1:'+p+'/api/dashboard-gateway/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["node", "gateway/dist/server.js"]
