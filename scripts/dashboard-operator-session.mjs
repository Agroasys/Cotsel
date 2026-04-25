#!/usr/bin/env node
import process from 'node:process';
import { Wallet } from 'ethers';
import {
  assertExpectedSession,
  buildAuthEndpointCandidates,
  DEFAULT_SESSION_OUTPUT_FILE,
  DEFAULT_TIMEOUT_MS,
  maskSessionId,
  normalizeTimeoutMs,
  writeSessionArtifact,
} from './lib/dashboard-operator-session.mjs';

const DEFAULT_AUTH_BASE_URL = 'http://127.0.0.1:3005/api/auth/v1';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function optionalEnv(name, fallback) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`missing required env var: ${name}`);
  }
  return value.trim();
}

function safeBodyPreview(payload) {
  if (payload === null || payload === undefined) {
    return 'null';
  }
  const serialized = JSON.stringify(payload);
  return serialized.length <= 500 ? serialized : `${serialized.slice(0, 500)}...`;
}

async function fetchJsonResponse(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = normalizeTimeoutMs(
    optionalEnv('DASHBOARD_SMOKE_REQUEST_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)),
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      fail(`${url} timed out after ${timeoutMs}ms`);
    }
    fail(`${url} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}) {
  const result = await fetchJsonResponse(url, options);
  if (!result.ok) {
    fail(`${url} returned HTTP ${result.status}: ${safeBodyPreview(result.payload)}`);
  }
  return result.payload;
}

async function fetchChallenge(authBaseUrl, walletAddress) {
  const attempts = [];
  for (const url of buildAuthEndpointCandidates(authBaseUrl, 'challenge', {
    wallet: walletAddress,
  })) {
    const result = await fetchJsonResponse(url.toString());
    attempts.push({
      url: url.toString(),
      status: result.status,
      body: safeBodyPreview(result.payload),
    });
    if (result.ok) {
      return {
        authBaseUrl: new URL('.', url).toString().replace(/\/$/u, ''),
        payload: result.payload,
      };
    }
    if (result.status !== 404) {
      fail(`${url} returned HTTP ${result.status}: ${safeBodyPreview(result.payload)}`);
    }
  }

  fail(
    `auth challenge route returned 404 for all candidate base paths: ${JSON.stringify(attempts, null, 2)}`,
  );
}

async function main() {
  const authBaseUrl = optionalEnv('DASHBOARD_SMOKE_AUTH_BASE_URL', DEFAULT_AUTH_BASE_URL);
  const outputPath = optionalEnv(
    'DASHBOARD_SMOKE_SESSION_OUTPUT_FILE',
    DEFAULT_SESSION_OUTPUT_FILE,
  );
  const privateKey = requiredEnv('DASHBOARD_SMOKE_PRIVATE_KEY');
  const role = optionalEnv('DASHBOARD_SMOKE_ROLE', 'admin');
  const orgId = optionalEnv('DASHBOARD_SMOKE_ORG_ID', '');

  const wallet = new Wallet(privateKey);
  const walletAddress = wallet.address;

  const challengeAttempt = await fetchChallenge(authBaseUrl, walletAddress);
  const resolvedAuthBaseUrl = challengeAttempt.authBaseUrl;
  const challengeEnvelope = challengeAttempt.payload;
  const challenge = challengeEnvelope?.data;
  if (!challenge?.message) {
    fail(`auth challenge payload missing message: ${JSON.stringify(challengeEnvelope)}`);
  }

  const signature = await wallet.signMessage(challenge.message);

  const loginEnvelope = await fetchJson(
    buildAuthEndpointCandidates(resolvedAuthBaseUrl, 'login')[0].toString(),
    {
      method: 'POST',
      body: JSON.stringify({
        walletAddress,
        signature,
        role,
        ...(orgId ? { orgId } : {}),
      }),
    },
  );
  const login = loginEnvelope?.data;
  if (!login?.sessionId) {
    fail(`auth login payload missing sessionId: ${JSON.stringify(loginEnvelope)}`);
  }

  const sessionEnvelope = await fetchJson(
    buildAuthEndpointCandidates(resolvedAuthBaseUrl, 'session')[0].toString(),
    {
      headers: {
        Authorization: `Bearer ${login.sessionId}`,
      },
    },
  );
  const session = sessionEnvelope?.data;
  try {
    assertExpectedSession({ session, walletAddress, role });
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(sessionEnvelope)}`,
    );
  }

  writeSessionArtifact({
    outputPath,
    artifact: {
      authBaseUrl: resolvedAuthBaseUrl,
      walletAddress,
      sessionId: login.sessionId,
      expiresAt: login.expiresAt,
      session,
    },
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        authBaseUrl: resolvedAuthBaseUrl,
        walletAddress,
        sessionFile: outputPath,
        sessionIdPreview: maskSessionId(login.sessionId),
        expiresAt: login.expiresAt,
        session,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
