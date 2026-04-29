#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_OUTPUT_FILE,
  DEFAULT_TIMEOUT_MS,
  maskSessionId,
  normalizeTimeoutMs,
  writeSessionArtifact,
} from './lib/dashboard-operator-session.mjs';

const require = createRequire(import.meta.url);
const {
  buildServiceAuthCanonicalString,
  signServiceAuthCanonicalString,
} = require('../shared-auth/src/serviceAuth.js');

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AUTH_BASE_URL = 'https://cotsel.sys.agroasys.com/api/auth/v1';
const DEFAULT_PROFILE_FILE = '.env.staging-e2e-real';
const TRUSTED_SESSION_API_KEYS_PREVIEW_MAX_LENGTH = 120;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};

  if (argv.length % 2 !== 0) {
    fail('arguments must be provided as --key value pairs');
  }

  for (let argIndex = 0; argIndex < argv.length; argIndex += 2) {
    const token = argv[argIndex];
    if (!token.startsWith('--')) {
      fail(`unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (argIndex + 1 >= argv.length) {
      fail(`missing value for --${key}`);
    }
    const value = argv[argIndex + 1];
    if (!value || value.startsWith('--')) {
      fail(`missing value for --${key}`);
    }

    parsed[key] = value;
  }

  return parsed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
  for (const line of lines) {
    if (line.trim().length === 0 || /^\s*#/u.test(line)) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_]+)=\s*(.*)$/u);
    if (!match) {
      continue;
    }

    let value = match[2].replace(/\s+$/u, '');
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return values;
}

function loadRuntimeEnv(profileFile) {
  return {
    ...loadEnvFile(path.join(ROOT_DIR, '.env')),
    ...loadEnvFile(path.join(ROOT_DIR, profileFile)),
    ...process.env,
  };
}

function buildUrl(baseUrl, pathname) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  return new URL(pathname.replace(/^\//u, ''), base).toString();
}

function parseTrustedSessionApiKeys(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const normalized = rawValue.replace(/\s+/gu, ' ').trim();
    const preview = normalized
      .slice(0, TRUSTED_SESSION_API_KEYS_PREVIEW_MAX_LENGTH)
      .replace(/[^\s]/gu, '*');
    fail(
      `TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON is not valid JSON. Check this environment variable in process.env or in your env files (.env and profile file). Expected a JSON array of API key objects, for example: [{"id":"key-id","secret":"key-secret","active":true}]. Received length=${rawValue.length}, redacted preview="${preview}${normalized.length > TRUSTED_SESSION_API_KEYS_PREVIEW_MAX_LENGTH ? '…' : ''}".`,
    );
  }
}

function pickTrustedSessionKey(keys, preferredId) {
  if (preferredId) {
    return keys.find((key) => key && key.id === preferredId && key.active === true) ?? null;
  }

  return keys.find((key) => key && key.active === true) ?? null;
}

function redactSensitivePreview(value, maxLength = 200) {
  const redacted = value
    .replace(
      /("?(?:token|access_token|refresh_token|api[_-]?key|secret|password|authorization|session(?:id)?)"?\s*[:=]\s*")([^"]*)(")/gi,
      '$1[REDACTED]$3',
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, '[REDACTED_AUTH]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…(truncated)` : redacted;
}

async function fetchJson(url, { body, headers, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
      signal: controller.signal,
    });

    const rawBody = await response.text();
    let payload = null;
    let jsonParseError = null;
    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        jsonParseError = error;
      }
    }
    if (!response.ok) {
      const responseDetails = jsonParseError
        ? `response body is not valid JSON (${jsonParseError instanceof Error ? jsonParseError.message : String(jsonParseError)}); bodyLength=${rawBody.length}; preview=${redactSensitivePreview(rawBody)}`
        : redactSensitivePreview(JSON.stringify(payload));
      fail(`${url} returned HTTP ${response.status}: ${responseDetails}`);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      fail(`${url} timed out after ${timeoutMs}ms`);
    }

    fail(`${url} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileFile = args['profile-file'] ?? DEFAULT_PROFILE_FILE;
  const runtimeEnv = loadRuntimeEnv(profileFile);
  const timeoutMs = normalizeTimeoutMs(
    args['timeout-ms'] ?? runtimeEnv.DASHBOARD_TRUSTED_SESSION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const authBaseUrl =
    args['auth-base-url'] ??
    runtimeEnv.DASHBOARD_TRUSTED_SESSION_AUTH_BASE_URL ??
    runtimeEnv.DASHBOARD_PARITY_AUTH_BASE_URL ??
    DEFAULT_AUTH_BASE_URL;
  const outputPath =
    args.output ?? runtimeEnv.DASHBOARD_TRUSTED_SESSION_OUTPUT_FILE ?? DEFAULT_SESSION_OUTPUT_FILE;
  const accountId = args['account-id'];
  const role = args.role;
  const walletAddress = args['wallet-address'] ?? null;
  const email = args.email ?? null;
  const orgId = args['org-id'] ?? null;

  if (!accountId) {
    fail('--account-id is required');
  }
  if (!role) {
    fail('--role is required');
  }

  const trustedSessionKeys = parseTrustedSessionApiKeys(
    runtimeEnv.TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON,
  );
  const trustedSessionKey = pickTrustedSessionKey(
    trustedSessionKeys,
    args['api-key-id'] ?? runtimeEnv.DASHBOARD_TRUSTED_SESSION_API_KEY_ID ?? null,
  );

  if (!trustedSessionKey) {
    fail(
      'No active trusted session exchange API key is available. Ensure TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON contains at least one active key. Optionally set DASHBOARD_TRUSTED_SESSION_API_KEY_ID to select a preferred key.',
    );
  }

  const requestPayload = {
    accountId,
    role,
  };
  if (orgId !== null && orgId !== undefined) {
    requestPayload.orgId = orgId;
  }
  if (email !== null && email !== undefined) {
    requestPayload.email = email;
  }
  if (walletAddress !== null && walletAddress !== undefined) {
    requestPayload.walletAddress = walletAddress;
  }
  const requestBody = JSON.stringify(requestPayload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodySha256 = crypto.createHash('sha256').update(requestBody).digest('hex');
  const requestPath = '/session/exchange/agroasys';
  const requestUrl = buildUrl(authBaseUrl, requestPath);
  const requestUrlPathname = new URL(requestUrl).pathname;
  const canonicalString = buildServiceAuthCanonicalString({
    method: 'POST',
    path: requestUrlPathname,
    query: '',
    bodySha256,
    timestamp,
    nonce,
  });
  const signature = signServiceAuthCanonicalString(trustedSessionKey.secret, canonicalString);

  const exchangeEnvelope = await fetchJson(requestUrl, {
    body: requestBody,
    timeoutMs,
    headers: {
      'X-Api-Key': trustedSessionKey.id,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature,
    },
  });

  const result = exchangeEnvelope?.data;
  if (!result?.sessionId) {
    fail(`trusted session exchange payload missing sessionId: ${JSON.stringify(exchangeEnvelope)}`);
  }

  writeSessionArtifact({
    outputPath,
    artifact: {
      authBaseUrl,
      accountId,
      role,
      walletAddress,
      email,
      orgId,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    },
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        authBaseUrl,
        accountId,
        role,
        walletAddress,
        email,
        orgId,
        sessionFile: outputPath,
        sessionIdPreview: maskSessionId(result.sessionId),
        expiresAt: result.expiresAt,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
