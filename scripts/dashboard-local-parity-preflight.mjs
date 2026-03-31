#!/usr/bin/env node
import process from "node:process";
import {
  createDashboardParityFailure,
  DASHBOARD_PARITY_FAILURE_CODES,
  DEFAULT_DASHBOARD_PARITY_AUTH_BASE_URL,
  DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID,
  DEFAULT_DASHBOARD_PARITY_GATEWAY_BASE_URL,
  DEFAULT_DASHBOARD_PARITY_SESSION_FILE,
  DEFAULT_DASHBOARD_PARITY_TIMEOUT_MS,
  exitCodeForDashboardParityFailure,
  formatDashboardParityFailure,
  buildUrl,
  explainReadyzFailure,
  inspectCanonicalTradeDetailPayload,
  optionalEnv,
  readDashboardParitySessionArtifact,
  readTradeDetailFromGatewayPayload,
  readTradeListFromGatewayPayload,
} from "./lib/dashboard-local-parity.mjs";

function fail(code, message, details = null, context = {}) {
  const failure = createDashboardParityFailure(code, message, details);
  process.stderr.write(`${formatDashboardParityFailure(failure, context)}\n`);
  process.exit(exitCodeForDashboardParityFailure(code));
}

async function fetchJson(name, url, failureCode, { bearer } = {}, context = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(
    optionalEnv("DASHBOARD_PARITY_REQUEST_TIMEOUT_MS", String(DEFAULT_DASHBOARD_PARITY_TIMEOUT_MS)),
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers({ Accept: "application/json" });
    if (bearer) {
      headers.set("Authorization", `Bearer ${bearer}`);
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      fail(
        failureCode,
        `${name} returned HTTP ${response.status}`,
        { url, status: response.status, payload },
        context,
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      fail(
        failureCode,
        `${name} timed out after ${timeoutMs}ms`,
        { url, timeoutMs },
        context,
      );
    }

    fail(
      failureCode,
      `${name} request failed`,
      { url, error: error instanceof Error ? error.message : String(error) },
      context,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const authBaseUrl = optionalEnv("DASHBOARD_PARITY_AUTH_BASE_URL", DEFAULT_DASHBOARD_PARITY_AUTH_BASE_URL);
  const gatewayBaseUrl = optionalEnv(
    "DASHBOARD_PARITY_GATEWAY_BASE_URL",
    DEFAULT_DASHBOARD_PARITY_GATEWAY_BASE_URL,
  );
  const sessionFile = optionalEnv("DASHBOARD_PARITY_SESSION_FILE", DEFAULT_DASHBOARD_PARITY_SESSION_FILE);
  const expectedTradeId = optionalEnv(
    "DASHBOARD_PARITY_EXPECTED_TRADE_ID",
    DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID,
  );
  const parityContext = {
    authBaseUrl,
    gatewayBaseUrl,
    sessionFile,
    expectedTradeId,
  };
  let sessionArtifact;
  try {
    sessionArtifact = readDashboardParitySessionArtifact(sessionFile);
  } catch (error) {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.SESSION_ARTIFACT_INVALID,
      "dashboard parity session artifact is invalid",
      { error: error instanceof Error ? error.message : String(error) },
      parityContext,
    );
  }
  const sessionBearer = sessionArtifact.sessionId.trim();

  const sessionEnvelope = await fetchJson(
    "auth /session",
    buildUrl(authBaseUrl, "session"),
    DASHBOARD_PARITY_FAILURE_CODES.AUTH_SESSION_REQUEST_FAILED,
    { bearer: sessionBearer },
    parityContext,
  );
  const healthz = await fetchJson(
    "gateway /healthz",
    buildUrl(gatewayBaseUrl, "healthz"),
    DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_HEALTH_REQUEST_FAILED,
    {},
    parityContext,
  );
  const readyz = await fetchJson(
    "gateway /readyz",
    buildUrl(gatewayBaseUrl, "readyz"),
    DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_READY_REQUEST_FAILED,
    {},
    parityContext,
  );
  const version = await fetchJson(
    "gateway /version",
    buildUrl(gatewayBaseUrl, "version"),
    DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_VERSION_REQUEST_FAILED,
    {},
    parityContext,
  );
  const tradesEnvelope = await fetchJson(
    "gateway /trades",
    buildUrl(gatewayBaseUrl, "trades", { limit: 1, offset: 0 }),
    DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADES_REQUEST_FAILED,
    { bearer: sessionBearer },
    parityContext,
  );
  const tradeDetailEnvelope = await fetchJson(
    "gateway /trades/:tradeId",
    buildUrl(gatewayBaseUrl, `trades/${encodeURIComponent(expectedTradeId)}`),
    DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADE_DETAIL_REQUEST_FAILED,
    { bearer: sessionBearer },
    parityContext,
  );

  const session = sessionEnvelope?.data ?? null;
  if (!session || typeof session !== "object") {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.AUTH_SESSION_PAYLOAD_INVALID,
      "auth /session returned no usable session payload",
      { payload: sessionEnvelope },
      parityContext,
    );
  }

  if (session.role !== "admin") {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.AUTH_SESSION_ROLE_INVALID,
      `local dashboard parity expects an admin session, received role=${String(session.role ?? "unknown")}`,
      { role: session.role ?? null },
      parityContext,
    );
  }

  if (readyz?.data?.ready !== true) {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_NOT_READY,
      `gateway /readyz is not ready. ${explainReadyzFailure(readyz)}`,
      { readyz },
      parityContext,
    );
  }

  let trades;
  try {
    trades = readTradeListFromGatewayPayload(tradesEnvelope);
  } catch (error) {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADES_PAYLOAD_INVALID,
      "gateway /trades returned an unexpected payload shape",
      {
        error: error instanceof Error ? error.message : String(error),
        payload: tradesEnvelope,
      },
      parityContext,
    );
  }
  const firstTradeId = trades[0] && typeof trades[0].id === "string" ? trades[0].id : null;
  if (!firstTradeId) {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.SEEDED_TRADE_MISSING,
      "gateway /trades returned zero trades. Enable `LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity` and restart local-dev before running dashboard live parity.",
      { payload: tradesEnvelope },
      parityContext,
    );
  }

  if (firstTradeId !== expectedTradeId) {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.SEEDED_TRADE_MISMATCH,
      `gateway /trades returned '${firstTradeId}', expected '${expectedTradeId}'. The local parity trade fixture is stale or a different dataset is active.`,
      { actualTradeId: firstTradeId },
      parityContext,
    );
  }

  let canonicalTradeDetail;
  try {
    readTradeDetailFromGatewayPayload(tradeDetailEnvelope);
    canonicalTradeDetail = inspectCanonicalTradeDetailPayload(tradeDetailEnvelope, expectedTradeId);
  } catch (error) {
    fail(
      DASHBOARD_PARITY_FAILURE_CODES.GATEWAY_TRADE_DETAIL_PAYLOAD_INVALID,
      "gateway /trades/:tradeId did not preserve the canonical Base-era trade detail contract",
      {
        error: error instanceof Error ? error.message : String(error),
        payload: tradeDetailEnvelope,
      },
      parityContext,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        authBaseUrl,
        gatewayBaseUrl,
        sessionFile,
        session: {
          role: session.role,
          userId: session.userId ?? null,
          walletAddress: session.walletAddress ?? null,
          expiresAt: session.expiresAt ?? null,
        },
        gateway: {
          healthz: healthz?.data ?? healthz,
          readyz: readyz?.data ?? readyz,
          version: version?.data ?? version,
        },
        seededTradeId: firstTradeId,
        seededTrade: canonicalTradeDetail,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
