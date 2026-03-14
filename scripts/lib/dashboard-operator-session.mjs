import { chmodSync, writeFileSync } from "node:fs";

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_SESSION_OUTPUT_FILE = "/tmp/ctsl-dashboard-session.json";

export function normalizeTimeoutMs(rawValue, fallback = DEFAULT_TIMEOUT_MS) {
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.trunc(numericValue);
}

export function assertExpectedSession({ session, walletAddress, role }) {
  if (!session?.walletAddress || !session?.role) {
    throw new Error("auth session payload missing required fields");
  }

  if (session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(`auth session wallet mismatch: expected ${walletAddress}, received ${session.walletAddress}`);
  }

  if (session.role !== role) {
    throw new Error(`auth session role mismatch: expected ${role}, received ${session.role}`);
  }
}

export function maskSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "missing";
  }

  if (sessionId.length <= 12) {
    return sessionId;
  }

  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

export function writeSessionArtifact({ outputPath, artifact }) {
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(outputPath, 0o600);
}
