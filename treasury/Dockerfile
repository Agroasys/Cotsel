FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json .npmrc ./
COPY treasury/package.json treasury/package.json
COPY sdk/package.json sdk/package.json
COPY shared-auth/package.json shared-auth/package.json
COPY shared-db/package.json shared-db/package.json
COPY shared-edge/package.json shared-edge/package.json
COPY shared-http/package.json shared-http/package.json

RUN npm ci --ignore-scripts

COPY sdk sdk
COPY shared-auth shared-auth
COPY shared-db shared-db
COPY shared-edge shared-edge
COPY shared-http shared-http
COPY treasury treasury

RUN npm run -w @agroasys/sdk build \
  && npm run -w treasury build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json .npmrc ./
COPY treasury/package.json treasury/package.json
COPY sdk/package.json sdk/package.json
COPY shared-auth/package.json shared-auth/package.json
COPY shared-db/package.json shared-db/package.json
COPY shared-edge/package.json shared-edge/package.json
COPY shared-http/package.json shared-http/package.json

RUN npm ci --omit=dev --ignore-scripts \
  --workspace treasury \
  --workspace @agroasys/sdk \
  --workspace @agroasys/shared-auth \
  --workspace @agroasys/shared-db \
  --workspace @agroasys/shared-edge \
  --workspace @agroasys/shared-http \
  --include-workspace-root=false \
  && npm cache clean --force

COPY --from=builder /app/sdk/dist /app/sdk/dist
COPY --from=builder /app/shared-auth /app/shared-auth
COPY --from=builder /app/shared-db /app/shared-db
COPY --from=builder /app/shared-edge /app/shared-edge
COPY --from=builder /app/shared-http /app/shared-http
COPY --from=builder /app/treasury/dist /app/treasury/dist
COPY --from=builder /app/treasury/src/database/schema.sql /app/treasury/src/database/schema.sql

RUN addgroup -S agro && adduser -S agro -G agro \
  && chown -R agro:agro /app

USER agro

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3200;fetch('http://127.0.0.1:'+p+'/api/treasury/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["node", "treasury/dist/server.js"]
