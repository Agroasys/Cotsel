import fs from "node:fs";

export const DEFAULT_DASHBOARD_PARITY_SESSION_FILE = "/tmp/cotsel-dashboard-session.json";
export const DEFAULT_DASHBOARD_PARITY_AUTH_BASE_URL = "http://127.0.0.1:3005/api/auth/v1";
export const DEFAULT_DASHBOARD_PARITY_GATEWAY_BASE_URL = "http://127.0.0.1:3600/api/dashboard-gateway/v1";
export const DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID = "TRD-LOCAL-9001";
export const DEFAULT_DASHBOARD_PARITY_TIMEOUT_MS = 8000;
export const DASHBOARD_PARITY_FAILURE_CODES = Object.freeze({
  SESSION_ARTIFACT_INVALID: "SESSION_ARTIFACT_INVALID",
  AUTH_SESSION_REQUEST_FAILED: "AUTH_SESSION_REQUEST_FAILED",
  AUTH_SESSION_PAYLOAD_INVALID: "AUTH_SESSION_PAYLOAD_INVALID",
  AUTH_SESSION_ROLE_INVALID: "AUTH_SESSION_ROLE_INVALID",
  GATEWAY_HEALTH_REQUEST_FAILED: "GATEWAY_HEALTH_REQUEST_FAILED",
  GATEWAY_READY_REQUEST_FAILED: "GATEWAY_READY_REQUEST_FAILED",
  GATEWAY_NOT_READY: "GATEWAY_NOT_READY",
  GATEWAY_VERSION_REQUEST_FAILED: "GATEWAY_VERSION_REQUEST_FAILED",
  GATEWAY_TRADES_REQUEST_FAILED: "GATEWAY_TRADES_REQUEST_FAILED",
  GATEWAY_TRADES_PAYLOAD_INVALID: "GATEWAY_TRADES_PAYLOAD_INVALID",
  GATEWAY_TRADE_DETAIL_REQUEST_FAILED: "GATEWAY_TRADE_DETAIL_REQUEST_FAILED",
  GATEWAY_TRADE_DETAIL_PAYLOAD_INVALID: "GATEWAY_TRADE_DETAIL_PAYLOAD_INVALID",
  SEEDED_TRADE_MISSING: "SEEDED_TRADE_MISSING",
  SEEDED_TRADE_MISMATCH: "SEEDED_TRADE_MISMATCH",
});

const DASHBOARD_PARITY_FAILURE_EXIT_CODES = Object.freeze({
  [DASHBOARD_PARITY_FAILURE_CODES.SESSION_ARTIFACT_INVALID]: 11,
  [DASHBOARD_PARITY_FAILURE_CODES.AUTH_SESSION_REQUEST_FAILED]: 12,
  [DASHBOARD_PARITY_FAILURE_CODES.AUTH_SESSION_PAYLOAD_INVALID]: 13,
  [DASHBOARD_PARITY_FAILURE_CODES.AUTH_SESSION_ROLE_INVALID]: 14,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_HEALTH_REQUEST_FAILED]: 21,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_READY_REQUEST_FAILED]: 22,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_NOT_READY]: 23,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_VERSION_REQUEST_FAILED]: 24,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADES_REQUEST_FAILED]: 25,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADES_PAYLOAD_INVALID]: 26,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADE_DETAIL_REQUEST_FAILED]: 27,
  [DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADE_DETAIL_PAYLOAD_INVALID]: 28,
  [DASHBOARD_PARITY_FAILURE_CODES.SEEDED_TRADE_MISSING]: 29,
  [DASHBOARD_PARITY_FAILURE_CODES.SEEDED_TRADE_MISMATCH]: 30,
});

export function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

export function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(path.replace(/^\//u, ""), ensureTrailingSlash(baseUrl));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function readDashboardParitySessionArtifact(path) {
  const raw = fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);

  if (typeof parsed.sessionId !== "string" || parsed.sessionId.trim().length === 0) {
    throw new Error(`Session artifact is missing sessionId: ${path}`);
  }

  return parsed;
}

export function readTradeListFromGatewayPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    return payload.data;
  }

  throw new Error("Gateway /trades returned an unexpected payload shape.");
}

export function readTradeDetailFromGatewayPayload(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.data && typeof payload.data === "object") {
    return payload.data;
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.id === "string") {
    return payload;
  }

  throw new Error("Gateway /trades/:tradeId returned an unexpected payload shape.");
}

function hasNestedField(value, fieldName) {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasNestedField(item, fieldName));
  }

  if (Object.prototype.hasOwnProperty.call(value, fieldName)) {
    return true;
  }

  return Object.values(value).some((item) => hasNestedField(item, fieldName));
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inspectCanonicalTradeDetailPayload(payload, expectedTradeId) {
  const trade = readTradeDetailFromGatewayPayload(payload);

  if (trade.id !== expectedTradeId) {
    throw new Error(
      `Gateway /trades/:tradeId returned trade '${String(trade.id ?? "unknown")}', expected '${expectedTradeId}'.`,
    );
  }

  if (hasNestedField(trade, "extrinsicHash")) {
    throw new Error("Gateway /trades/:tradeId still exposes extrinsicHash in the live parity payload.");
  }

  if (!Array.isArray(trade.timeline) || trade.timeline.length === 0) {
    throw new Error("Gateway /trades/:tradeId returned no timeline records for the canonical parity trade.");
  }

  const timelineTxHash = trade.timeline.find((event) => optionalString(event?.txHash))?.txHash ?? null;
  const canonicalTxHash =
    optionalString(trade.txHash) ??
    optionalString(trade.settlement?.txHash) ??
    optionalString(timelineTxHash);

  if (!canonicalTxHash) {
    throw new Error("Gateway /trades/:tradeId returned no canonical txHash in the trade or timeline payload.");
  }

  return {
    tradeId: trade.id,
    canonicalTxHash,
    tradeTxHash: optionalString(trade.txHash),
    settlementTxHash: optionalString(trade.settlement?.txHash),
    timelineTxHash: optionalString(timelineTxHash),
  };
}

export function createDashboardParityFailure(code, message, details = null) {
  return {
    ok: false,
    code,
    message,
    ...(details ? { details } : {}),
  };
}

export function exitCodeForDashboardParityFailure(code) {
  return DASHBOARD_PARITY_FAILURE_EXIT_CODES[code] ?? 1;
}

export function formatDashboardParityFailure(failure, context = {}) {
  return JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      ...context,
      error: failure,
    },
    null,
    2,
  );
}

export function explainReadyzFailure(readyzPayload) {
  const dependencies = Array.isArray(readyzPayload?.data?.dependencies)
    ? readyzPayload.data.dependencies
    : [];
  const chainDependency = dependencies.find((dependency) => dependency?.name === "chain-rpc");
  if (chainDependency?.status === "unavailable") {
    return "Deploy the local AgroasysEscrow contract to Hardhat before rerunning parity: `cd contracts && npx hardhat ignition deploy ./ignition/modules/AgroasysEscrow.ts --network localhost`.";
  }

  const indexerDependency = dependencies.find((dependency) => dependency?.name === "indexer-graphql");
  if (indexerDependency?.status === "unavailable") {
    return "Enable the local parity trade fixture and restart local-dev: set `LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity` in `.env.local`, then rerun `scripts/docker-services.sh up local-dev`.";
  }

  return "Inspect the local auth, gateway, and local-dev profile logs before rerunning parity.";
}
