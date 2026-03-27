import fs from "node:fs";

export const DEFAULT_DASHBOARD_PARITY_SESSION_FILE = "/tmp/cotsel-dashboard-session.json";
export const DEFAULT_DASHBOARD_PARITY_AUTH_BASE_URL = "http://127.0.0.1:3005/api/auth/v1";
export const DEFAULT_DASHBOARD_PARITY_GATEWAY_BASE_URL = "http://127.0.0.1:3600/api/dashboard-gateway/v1";
export const DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID = "TRD-LOCAL-9001";
export const DEFAULT_DASHBOARD_PARITY_TIMEOUT_MS = 8000;

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
