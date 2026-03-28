import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID,
  buildUrl,
  explainReadyzFailure,
  readTradeListFromGatewayPayload,
} from "../lib/dashboard-local-parity.mjs";

test("buildUrl appends relative paths and query parameters consistently", () => {
  assert.equal(
    buildUrl("http://127.0.0.1:3600/api/dashboard-gateway/v1", "trades", { limit: 1, offset: 0 }),
    "http://127.0.0.1:3600/api/dashboard-gateway/v1/trades?limit=1&offset=0",
  );
});

test("readTradeListFromGatewayPayload accepts the gateway success envelope", () => {
  const payload = {
    data: [{ id: DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID }],
  };

  const trades = readTradeListFromGatewayPayload(payload);
  assert.equal(trades[0].id, DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID);
});

test("explainReadyzFailure surfaces the concrete parity remediation path", () => {
  assert.match(
    explainReadyzFailure({
      data: {
        dependencies: [{ name: "chain-rpc", status: "unavailable" }],
      },
    }),
    /hardhat ignition deploy/,
  );

  assert.match(
    explainReadyzFailure({
      data: {
        dependencies: [{ name: "indexer-graphql", status: "unavailable" }],
      },
    }),
    /LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity/,
  );
});
