import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_DEV_INDEXER_FIXTURE_EMPTY = "empty";
export const LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY = "dashboard-parity";
export const DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_MODE = LOCAL_DEV_INDEXER_FIXTURE_EMPTY;
export const DASHBOARD_PARITY_TRADE_ID = "TRD-LOCAL-9001";
export const DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/local-dev-dashboard-parity-trade.json",
);

export function normalizeLocalDevIndexerFixtureMode(rawValue) {
  const value = typeof rawValue === "string" && rawValue.trim().length > 0
    ? rawValue.trim()
    : DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_MODE;

  if (
    value !== LOCAL_DEV_INDEXER_FIXTURE_EMPTY &&
    value !== LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY
  ) {
    throw new Error(
      `Unsupported LOCAL_DEV_INDEXER_FIXTURE_MODE='${value}'. Expected '${LOCAL_DEV_INDEXER_FIXTURE_EMPTY}' or '${LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY}'.`,
    );
  }

  return value;
}

function assertStringField(record, field) {
  if (typeof record[field] !== "string" || record[field].trim().length === 0) {
    throw new Error(`Local parity trade fixture is missing required string field '${field}'.`);
  }
}

function assertNullableStringField(record, field) {
  if (record[field] !== null && record[field] !== undefined && typeof record[field] !== "string") {
    throw new Error(`Local parity trade fixture field '${field}' must be a string or null.`);
  }
}

function validateTradeEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("Local parity trade fixture contains an invalid event record.");
  }

  assertStringField(event, "eventName");
  assertStringField(event, "timestamp");
  assertNullableStringField(event, "txHash");
  assertNullableStringField(event, "extrinsicHash");
}

export function validateLocalDevParityTradeFixture(record) {
  if (!record || typeof record !== "object") {
    throw new Error("Local parity trade fixture must be an object.");
  }

  for (const field of [
    "tradeId",
    "buyer",
    "supplier",
    "status",
    "totalAmountLocked",
    "logisticsAmount",
    "platformFeesAmount",
    "supplierFirstTranche",
    "supplierSecondTranche",
    "ricardianHash",
    "createdAt",
  ]) {
    assertStringField(record, field);
  }

  assertNullableStringField(record, "arrivalTimestamp");

  if (!Array.isArray(record.events)) {
    throw new Error("Local parity trade fixture must provide an events array.");
  }

  for (const event of record.events) {
    validateTradeEvent(event);
  }

  return record;
}

export async function loadLocalDevTradeFixtures({
  fixtureMode = DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_MODE,
  fixturePath = DEFAULT_LOCAL_DEV_INDEXER_FIXTURE_PATH,
} = {}) {
  const mode = normalizeLocalDevIndexerFixtureMode(fixtureMode);
  if (mode === LOCAL_DEV_INDEXER_FIXTURE_EMPTY) {
    return [];
  }

  const raw = await fs.readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw);
  return [validateLocalDevParityTradeFixture(parsed)];
}

function normalizePaginationValue(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

export function buildLocalDevIndexerResponse({
  operationName,
  variables = {},
  trades,
}) {
  const list = Array.isArray(trades) ? trades : [];
  const offset = normalizePaginationValue(variables.offset, 0);
  const limit = normalizePaginationValue(variables.limit, list.length);
  const paginatedTrades = list.slice(offset, offset + limit);

  if (operationName === "DashboardTradeDetail") {
    const tradeId = typeof variables.tradeId === "string" ? variables.tradeId : "";
    return {
      data: {
        trades: tradeId ? list.filter((trade) => trade.tradeId === tradeId) : [],
      },
    };
  }

  if (operationName === "DashboardGatewayTradeReadiness") {
    return {
      data: {
        trades: list.map((trade) => ({ tradeId: trade.tradeId })),
      },
    };
  }

  return {
    data: {
      trades: paginatedTrades,
    },
  };
}
