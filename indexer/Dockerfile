FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json .npmrc ./
COPY contracts/package.json contracts/package.json
COPY indexer/package.json indexer/package.json
COPY notifications/package.json notifications/package.json
COPY oracle/package.json oracle/package.json
COPY reconciliation/package.json reconciliation/package.json
COPY ricardian/package.json ricardian/package.json
COPY sdk/package.json sdk/package.json
COPY treasury/package.json treasury/package.json
COPY patches patches

RUN npm ci --ignore-scripts --workspace indexer --include-workspace-root=false
RUN npx patch-package --error-on-fail

COPY indexer indexer

RUN npm run -w indexer build
RUN npm prune --omit=dev --workspace indexer --include-workspace-root=false

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/indexer/package.json /app/indexer/package.json
COPY --from=builder /app/indexer/lib /app/indexer/lib
COPY --from=builder /app/indexer/db /app/indexer/db
COPY --from=builder /app/indexer/schema.graphql /app/indexer/schema.graphql

WORKDIR /app/indexer

CMD ["node", "-r", "dotenv/config", "lib/main.js"]
