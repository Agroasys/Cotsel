FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json .npmrc ./
COPY sdk sdk
COPY notifications notifications
COPY oracle oracle

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm ci

RUN npm run -w @agroasys/sdk build \
  && npm run -w @agroasys/notifications build \
  && npm run -w oracle build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json .npmrc ./
COPY oracle/package.json oracle/package.json
COPY sdk/package.json sdk/package.json
COPY notifications/package.json notifications/package.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm pkg delete scripts.prepare --workspace @agroasys/notifications || true

RUN npm ci --omit=dev --ignore-scripts \
  --workspace @agroasys/notifications \
  --workspace @agroasys/sdk \
  --workspace oracle \
  --include-workspace-root=false \
  && npm cache clean --force

COPY --from=builder /app/notifications/dist /app/notifications/dist
COPY --from=builder /app/sdk/dist /app/sdk/dist
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
