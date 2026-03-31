FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json .npmrc ./
COPY auth/package.json auth/package.json
COPY sdk/package.json sdk/package.json
COPY shared-auth/package.json shared-auth/package.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm ci --ignore-scripts

COPY auth auth
COPY shared-auth shared-auth

RUN npm run -w auth build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json .npmrc ./
COPY auth/package.json auth/package.json
COPY shared-auth/package.json shared-auth/package.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm ci --omit=dev --ignore-scripts \
  --workspace @agroasys/shared-auth \
  --workspace auth \
  --include-workspace-root=false \
  && npm cache clean --force

COPY --from=builder /app/shared-auth /app/shared-auth
COPY --from=builder /app/auth/dist /app/auth/dist
COPY --from=builder /app/auth/src/database/schema.sql /app/auth/src/database/schema.sql

RUN groupadd --system agro \
  && useradd --system --gid agro --create-home agro \
  && chown -R agro:agro /app

USER agro

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3005;fetch('http://127.0.0.1:'+p+'/api/auth/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["node", "auth/dist/server.js"]
