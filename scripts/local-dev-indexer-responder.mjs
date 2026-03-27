#!/usr/bin/env node
import http from "node:http";
import process from "node:process";
import {
  DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_MODE,
  DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_PATH,
  buildLocalDevIndexerResponse,
  loadLocalDevTradeFixtures,
  normalizeLocalDevIndexerFixtureMode,
} from "./lib/local-dev-indexer-fixture.mjs";

const port = Number(process.env.LOCAL_DEV_INDEXER_PORT || "4350");
const fixtureMode = normalizeLocalDevIndexerFixtureMode(
  process.env.LOCAL_DEV_INDEXER_FIXTURE_MODE || DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_MODE,
);
const fixturePath = process.env.LOCAL_DEV_INDEXER_FIXTURE_PATH || DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_PATH;
const trades = await loadLocalDevTradeFixtures({ fixtureMode, fixturePath });

const server = http.createServer((req, res) => {
  if (req.url !== "/graphql" || req.method !== "POST") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  let rawBody = "";
  req.on("data", (chunk) => {
    rawBody += chunk;
  });

  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch {
      payload = {};
    }

    const body = buildLocalDevIndexerResponse({
      operationName: typeof payload.operationName === "string" ? payload.operationName : "",
      variables: payload.variables && typeof payload.variables === "object" ? payload.variables : {},
      trades,
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(
    `${JSON.stringify(
      {
        service: "local-dev-indexer-responder",
        fixtureMode,
        fixturePath: fixtureMode === "dashboard-parity" ? fixturePath : null,
        tradeCount: trades.length,
        port,
      },
      null,
      2,
    )}\n`,
  );
});
