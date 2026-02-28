#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be numeric (received: ${raw})`);
  }
  return parsed;
}

function extractField(payload, title) {
  const attachment = payload?.attachments?.[0];
  if (!attachment || !Array.isArray(attachment.fields)) {
    return null;
  }
  const field = attachment.fields.find((entry) => entry?.title === title);
  return field ? String(field.value) : null;
}

function startCaptureServer() {
  const capturedPayloads = [];

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/hooks/alerts") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not-found" }));
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        capturedPayloads.push({
          receivedAt: new Date().toISOString(),
          payload,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error?.message || "invalid-json" }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("unable to determine capture server port"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        baseUrl,
        capturedPayloads,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

async function main() {
  const profile = (process.env.NOTIFICATIONS_GATE_PROFILE || "staging-e2e-real").trim();
  const outFile = (process.env.NOTIFICATIONS_GATE_OUT_FILE || `reports/notifications/${profile}.json`).trim();

  const report = {
    generatedAt: new Date().toISOString(),
    profile,
    checks: {
      oracleCriticalDelivery: false,
      reconciliationCriticalDelivery: false,
      oracleDedupSuppressed: false,
      reconciliationDedupSuppressed: false,
      severityRoutePager: false,
      templateVersionTagged: false,
    },
    evidence: {
      oracleEventType: "ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE",
      reconciliationEventType: "RECONCILIATION_CRITICAL_DRIFT",
      capturedCount: 0,
    },
    events: [],
    errors: [],
    pass: false,
  };

  const notificationsModulePath = path.resolve("notifications", "dist", "index.js");
  if (!fs.existsSync(notificationsModulePath)) {
    throw new Error(
      `Missing notifications build output (${notificationsModulePath}). Run: npm run -w notifications build`,
    );
  }

  const { WebhookNotifier, NOTIFICATION_TEMPLATE_VERSIONS } = require(notificationsModulePath);

  const oracleCooldownMs = readNumberEnv("ORACLE_NOTIFICATIONS_COOLDOWN_MS", 300000);
  const oracleTimeoutMs = readNumberEnv("ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS", 5000);
  const reconciliationCooldownMs = readNumberEnv("RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS", 300000);
  const reconciliationTimeoutMs = readNumberEnv("RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS", 5000);

  const capture = await startCaptureServer();
  try {
    const webhookUrl = `${capture.baseUrl}/hooks/alerts`;

    const healthResponse = await fetch(`${capture.baseUrl}/health`);
    if (!healthResponse.ok) {
      throw new Error(`capture server health check failed: http ${healthResponse.status}`);
    }

    const oracleNotifier = new WebhookNotifier({
      enabled: true,
      webhookUrl,
      cooldownMs: oracleCooldownMs,
      requestTimeoutMs: oracleTimeoutMs,
    });

    const reconciliationNotifier = new WebhookNotifier({
      enabled: true,
      webhookUrl,
      cooldownMs: reconciliationCooldownMs,
      requestTimeoutMs: reconciliationTimeoutMs,
    });

    const oracleEvent = {
      source: "oracle",
      type: report.evidence.oracleEventType,
      severity: "critical",
      dedupKey: `notifications-gate:${profile}:oracle:critical`,
      message: "Notification gate probe for critical oracle settlement path",
      correlation: {
        actionKey: `gate-${profile}-oracle`,
        runKey: `gate-${Date.now()}`,
      },
    };

    const reconciliationEvent = {
      source: "reconciliation",
      type: report.evidence.reconciliationEventType,
      severity: "critical",
      dedupKey: `notifications-gate:${profile}:reconciliation:critical`,
      message: "Notification gate probe for critical reconciliation drift path",
      correlation: {
        runKey: `gate-${Date.now()}`,
        mismatchCode: "CRITICAL_DRIFT",
      },
    };

    const oracleSent = await oracleNotifier.notify(oracleEvent);
    const reconciliationSent = await reconciliationNotifier.notify(reconciliationEvent);

    report.checks.oracleCriticalDelivery = oracleSent;
    report.checks.reconciliationCriticalDelivery = reconciliationSent;

    const beforeDedupCount = capture.capturedPayloads.length;

    const oracleSecondSend = await oracleNotifier.notify(oracleEvent);
    const reconciliationSecondSend = await reconciliationNotifier.notify(reconciliationEvent);

    report.checks.oracleDedupSuppressed = oracleSecondSend === false;
    report.checks.reconciliationDedupSuppressed = reconciliationSecondSend === false;

    report.evidence.capturedCount = capture.capturedPayloads.length;

    if (capture.capturedPayloads.length !== beforeDedupCount) {
      report.errors.push(
        `dedup suppression failed: expected captured count ${beforeDedupCount}, observed ${capture.capturedPayloads.length}`,
      );
    }

    const oraclePayload = capture.capturedPayloads
      .map((entry) => entry.payload)
      .find((payload) => String(payload?.text || "").includes(report.evidence.oracleEventType));

    const reconciliationPayload = capture.capturedPayloads
      .map((entry) => entry.payload)
      .find((payload) => String(payload?.text || "").includes(report.evidence.reconciliationEventType));

    if (!oraclePayload) {
      report.errors.push(`missing captured payload for ${report.evidence.oracleEventType}`);
    }
    if (!reconciliationPayload) {
      report.errors.push(`missing captured payload for ${report.evidence.reconciliationEventType}`);
    }

    const oracleSeverityRoute = extractField(oraclePayload, "severityRoute");
    const reconciliationSeverityRoute = extractField(reconciliationPayload, "severityRoute");

    report.checks.severityRoutePager =
      oracleSeverityRoute === "pager" && reconciliationSeverityRoute === "pager";

    const oracleTemplateVersion = extractField(oraclePayload, "templateVersion");
    const reconciliationTemplateVersion = extractField(reconciliationPayload, "templateVersion");

    report.checks.templateVersionTagged =
      oracleTemplateVersion === NOTIFICATION_TEMPLATE_VERSIONS[report.evidence.oracleEventType] &&
      reconciliationTemplateVersion ===
        NOTIFICATION_TEMPLATE_VERSIONS[report.evidence.reconciliationEventType];

    report.events = capture.capturedPayloads.map((entry) => ({
      receivedAt: entry.receivedAt,
      text: entry.payload?.text || null,
      severityRoute: extractField(entry.payload, "severityRoute"),
      templateVersion: extractField(entry.payload, "templateVersion"),
    }));
  } catch (error) {
    report.errors.push(error?.message || String(error));
  } finally {
    await capture.close();
  }

  report.pass =
    report.checks.oracleCriticalDelivery &&
    report.checks.reconciliationCriticalDelivery &&
    report.checks.oracleDedupSuppressed &&
    report.checks.reconciliationDedupSuppressed &&
    report.checks.severityRoutePager &&
    report.checks.templateVersionTagged &&
    report.errors.length === 0;

  const outPath = path.resolve(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!report.pass) {
    throw new Error(`notifications gate failed (report: ${outPath})`);
  }

  console.log(`notifications gate passed: ${outPath}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
