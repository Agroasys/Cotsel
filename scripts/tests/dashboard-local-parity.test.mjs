import test from "node:test";
import assert from "node:assert/strict";

import {
  createDashboardParityFailure,
  DASHBOARD_PARITY_FAILURE_CODES,
  DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID,
  buildUrl,
  exitCodeForDashboardParityFailure,
  formatDashboardParityFailure,
  explainReadyzFailure,
  readDashboardParitySessionArtifact,
  readTradeListFromGatewayPayload,
} from "../lib/dashboard-local-parity.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("readDashboardParitySessionArtifact rejects artifacts without a session id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-parity-"));
  const artifactPath = path.join(tempDir, "invalid-session.json");
  fs.writeFileSync(artifactPath, JSON.stringify({ sessionId: "" }), "utf8");

  assert.throws(
    () => readDashboardParitySessionArtifact(artifactPath),
    /missing sessionId/,
  );
});

test("dashboard parity failures render machine-usable codes and exit mappings", () => {
  const failure = createDashboardParityFailure(
    DASHBOARD_PARITY_FAILURE_CODES.SEEDED_TRADE_MISMATCH,
    "expected canonical trade",
    { actualTradeId: "TRD-OTHER" },
  );
  const rendered = JSON.parse(
    formatDashboardParityFailure(failure, { gatewayBaseUrl: "http://127.0.0.1:3600/api/dashboard-gateway/v1" }),
  );

  assert.equal(rendered.error.code, DASHBOARD_PARITY_FAILURE_CODES.SEEDED_TRADE_MISMATCH);
  assert.equal(rendered.error.details.actualTradeId, "TRD-OTHER");
  assert.equal(
    exitCodeForDashboardParityFailure(DASHBOARD_PARITY_FAILURE_CODES.SEEDED_TRADE_MISMATCH),
    28,
  );
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
