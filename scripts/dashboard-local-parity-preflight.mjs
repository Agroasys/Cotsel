#!/usr/bin/env node
import process from "node:process";
import {
  DEFAULT_DASHBOARD_PARITY_AUTH_BASE_URL,
  DEFAULT_DASHBOARD_PARITY_EXPECTED_TRADE_ID,
  DEFAULT_DASHBOARD_PARITY_GATEWAY_BASE_URL,
  DEFAULT_DASHBOARD_PARITY_SESSION_FILE,
  DEFAULT_DASHBOARD_PARITY_TIMEOUT_MS,
  buildUrl,
  explainReadyzFailure,
  optionalEnv,
  readDashboardParitySessionArtifact,
  readTradeListFromGatewayPayload,
} from "./lib/dashboard-local-parity.mjs";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function fetchJson(url, { bearer } = {}) {
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
      fail(`${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      fail(`${url} timed out after ${timeoutMs}ms`);
    }

    fail(`${url} request failed: ${error instanceof Error ? error.message : String(error)}`);
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
  const sessionArtifact = readDashboardParitySessionArtifact(sessionFile);
  const sessionBearer = sessionArtifact.sessionId.trim();

  const sessionEnvelope = await fetchJson(buildUrl(authBaseUrl, "session"), { bearer: sessionBearer });
  const healthz = await fetchJson(buildUrl(gatewayBaseUrl, "healthz"));
  const readyz = await fetchJson(buildUrl(gatewayBaseUrl, "readyz"));
  const version = await fetchJson(buildUrl(gatewayBaseUrl, "version"));
  const tradesEnvelope = await fetchJson(buildUrl(gatewayBaseUrl, "trades", { limit: 1, offset: 0 }), {
    bearer: sessionBearer,
  });

  const session = sessionEnvelope?.data ?? null;
  if (!session || typeof session !== "object") {
    fail("auth /session returned no session payload");
  }

  if (session.role !== "admin") {
    fail(`local dashboard parity expects an admin session, received role=${String(session.role ?? "unknown")}`);
  }

  if (readyz?.data?.ready !== true) {
    fail(`gateway /readyz is not ready. ${explainReadyzFailure(readyz)}`);
  }

  const trades = readTradeListFromGatewayPayload(tradesEnvelope);
  const firstTradeId = trades[0] && typeof trades[0].id === "string" ? trades[0].id : null;
  if (!firstTradeId) {
    fail(
      "gateway /trades returned zero trades. Enable `LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity` and restart local-dev before running dashboard live parity.",
    );
  }

  if (firstTradeId !== expectedTradeId) {
    fail(
      `gateway /trades returned '${firstTradeId}', expected '${expectedTradeId}'. The local parity trade fixture is stale or a different dataset is active.`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  );
}

await main();
