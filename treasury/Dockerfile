FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY treasury/package.json treasury/package.json
COPY shared-auth/package.json shared-auth/package.json

RUN npm ci --ignore-scripts

COPY treasury treasury
COPY shared-auth shared-auth

RUN npm run -w treasury build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY treasury/package.json treasury/package.json
COPY shared-auth/package.json shared-auth/package.json

RUN npm ci --omit=dev --ignore-scripts --workspace treasury --workspace @agroasys/shared-auth --include-workspace-root=false \
  && npm cache clean --force

COPY --from=builder /app/treasury/dist /app/treasury/dist
COPY --from=builder /app/treasury/src/database/schema.sql /app/treasury/src/database/schema.sql
COPY --from=builder /app/shared-auth /app/shared-auth

RUN addgroup -S agro && adduser -S agro -G agro \
  && chown -R agro:agro /app

USER agro

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3200;fetch('http://127.0.0.1:'+p+'/api/treasury/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["node", "treasury/dist/server.js"]