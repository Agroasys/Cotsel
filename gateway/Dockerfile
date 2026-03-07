FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY gateway/package.json gateway/package.json

RUN npm ci

COPY docs docs
COPY gateway gateway

RUN npm run -w gateway build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY gateway/package.json gateway/package.json

RUN npm ci --omit=dev --workspace gateway --include-workspace-root=false \
  && npm cache clean --force

COPY --from=builder /app/gateway/dist /app/gateway/dist
COPY --from=builder /app/gateway/src/database/schema.sql /app/gateway/src/database/schema.sql

RUN addgroup -S agro && adduser -S agro -G agro \
  && chown -R agro:agro /app

USER agro

EXPOSE 3600

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3600;fetch('http://127.0.0.1:'+p+'/api/dashboard-gateway/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["node", "gateway/dist/server.js"]
