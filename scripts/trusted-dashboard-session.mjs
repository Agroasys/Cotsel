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

const SENSITIVE_KEY_PATTERN =
  '(?:token|access_token|refresh_token|api[_-]?key|secret|password|authorization|session(?:id)?)';
// 16 random bytes = 128-bit nonce baseline for signed request uniqueness.
const NONCE_BYTES = 16;
const DEFAULT_TRUSTED_SESSION_EXCHANGE_PATH = 'session/exchange/agrosys';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AUTH_BASE_URL = 'https://cotsel.sys.agrosys.com/api/auth/v1';
const DEFAULT_PROFILE_FILE = '.env.staging-e2e-integration';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function resolveTrustedSessionExchangePath(args, runtimeEnv) {
  return (
    args['exchange-path'] ??
    runtimeEnv.TRUSTED_SESSION_EXCHANGE_PATH ??
    DEFAULT_TRUSTED_SESSION_EXCHANGE_PATH
  );
}

function parseArgs(argv) {
  const parsed = {};

  if (argv.length % 2 !== 0) {
    fail(
      `command arguments must be provided as --key value pairs (for example: --account-id 123 --role admin) (received ${argv.length} command argument(s))`,
    );
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
  const values = {};
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  for (const line of lines) {
    if (line.trim().length === 0 || /^\s*#/u.test(line)) {
      continue;
    }

    // Parse dotenv-style KEY=VALUE entries.
    // Capture groups:
    //   1) variable name (letters, digits, underscore),
    //   2) double-quoted value (supports escaped characters like \" and \\),
    //   3) single-quoted value (supports escaped characters like \' and \\),
    //   4) unquoted value (up to inline comment/end of line).
    // Optional whitespace is allowed around the value and before line end.
    const match = line.match(
      /^([A-Za-z0-9_]+)=\s*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^#\r\n]*))\s*$/u,
    );
    if (!match) {
      continue;
    }

    const key = match[1];
    let value;
    if (match[2] !== undefined) {
      value = match[2].replace(/\\(.)/gu, '$1');
    } else if (match[3] !== undefined) {
      value = match[3].replace(/\\(.)/gu, '$1');
    } else {
      const valueWithTrailingWhitespace = match[4] ?? '';
      value = valueWithTrailingWhitespace.replace(/\s+$/u, '');
    }
    values[key] = value;
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
  const url = new URL(pathname, baseUrl);
  return {
    href: url.toString(),
    pathname: url.pathname,
  };
}

function parseTrustedSessionApiKeys(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    fail(
      'Missing required TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON. Set this environment variable in process.env or in your env files (.env and profile file). Expected a JSON array of API key objects, for example: [{"id":"key-id","secret":"key-secret","active":true}].',
    );
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    fail(
      'TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON is not valid JSON. Check this environment variable in process.env or in your env files (.env and profile file). Expected a JSON array of API key objects, for example: [{"id":"key-id","secret":"key-secret","active":true}]. Redacted preview="[REDACTED]".',
    );
  }
}

function pickTrustedSessionKey(keys, preferredId) {
  const isValidActiveKey = (key) =>
    key &&
    typeof key.id === 'string' &&
    key.id.length > 0 &&
    typeof key.secret === 'string' &&
    key.secret.length > 0 &&
    key.active === true;

  if (preferredId) {
    return keys.find((key) => isValidActiveKey(key) && key.id === preferredId) ?? null;
  }

  return keys.find((key) => isValidActiveKey(key)) ?? null;
}

/**
 * Produces a safe preview string for logs and error messages by redacting sensitive material.
 *
 * This helper is intended for sanitizing untrusted/free-form text before any console output,
 * thrown error detail, or diagnostic message. It performs best-effort pattern-based redaction
 * for common secret-bearing content, including:
 * - token/secret/password/API-key/session-id style key/value pairs,
 * - sensitive URL query parameter values,
 * - Authorization header credentials,
 * - cookie/set-cookie sensitive values,
 * - inline Bearer/Basic auth credentials in free-form text.
 *
 * @param {string} value - The string to sanitize and redact before logging or display.
 * @param {number} [maxLength=200] - Maximum length of the returned preview before truncation.
 * @returns {string} The redacted preview string, truncated with an ellipsis marker when it exceeds `maxLength`.
 */
function createRedactedPreview(value, maxLength = 200) {
  const redacted = value
    // Redact object/JSON-style sensitive key-value pairs (e.g. "token":"abc", secret=xyz).
    .replace(
      new RegExp(
        `(["']?${SENSITIVE_KEY_PATTERN}["']?\\s*[:=]\\s*["']?)([^\\s"',;}&]+)(["']?)`,
        'gi',
      ),
      '$1[REDACTED]$3',
    )
    // Redact sensitive query parameters in URLs (e.g. ?api_key=..., &token=...).
    .replace(new RegExp(`([?&]${SENSITIVE_KEY_PATTERN}=)([^&#\\s]+)`, 'gi'), '$1[REDACTED]')
    // Redact Authorization header credentials (e.g. Authorization: Bearer ...).
    .replace(/\b(authorization\s*:\s*)([A-Za-z][A-Za-z0-9_-]*\s+[^\s,;]+)/gi, '$1[REDACTED_AUTH]')
    // Redact sensitive cookie values in Cookie/Set-Cookie headers.
    .replace(
      new RegExp(
        `(\\b(?:cookie|set-cookie)\\s*:\\s*[^\\n]*?\\b${SENSITIVE_KEY_PATTERN}=)([^;\\s]+)`,
        'gi',
      ),
      '$1[REDACTED]',
    )
    // Redact inline Basic/Bearer auth tokens appearing in free-form text.
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, '[REDACTED_AUTH]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…(truncated)` : redacted;
}

/**
 * Sends a JSON POST request and parses the response body when present.
 *
 * Returns parsed JSON for successful responses with a non-empty body.
 * Returns `null` only when the response is successful (`response.ok`) and the
 * response body is empty.
 *
 * For non-success responses (including empty-body responses), invalid JSON, or
 * transport/timeout failures, this function terminates via `fail(...)`.
 *
 * @param {string} url - Absolute URL to send the request to.
 * @param {{ body?: string, headers?: Record<string, string>, timeoutMs: number, operation?: string }} options
 *   Request options.
 * @param {string} [options.body] - Serialized request body (typically JSON string).
 * @param {Record<string, string>} [options.headers] - Additional request headers.
 * @param {number} options.timeoutMs - Timeout in milliseconds before aborting the request.
 * @param {string} [options.operation] - Logical operation being performed for clearer error messages.
 * @returns {Promise<object|null>} Parsed JSON response payload, or null when a successful response has an empty body.
 */
async function fetchJson(url, { body, headers, timeoutMs, operation }) {
  const operationLabel = operation ?? 'trusted session exchange request';
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail(`${operationLabel} requires a positive finite timeoutMs value`);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
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
    if (rawBody.length === 0) {
      if (!response.ok) {
        fail(
          `${operationLabel} (${url}) returned HTTP ${response.status} with empty response body`,
        );
      }
      return null;
    }

    try {
      const payload = JSON.parse(rawBody);
      if (!response.ok) {
        fail(
          `${operationLabel} (${url}) returned HTTP ${response.status}: ${createRedactedPreview(JSON.stringify(payload))}`,
        );
      }
      return payload;
    } catch (error) {
      const parseErrorDetails = error instanceof Error ? error.message : String(error);
      if (!response.ok) {
        fail(
          `${operationLabel} (${url}) returned HTTP ${response.status}: response body is not valid JSON (${parseErrorDetails}); bodyLength=${rawBody.length}; preview=${createRedactedPreview(rawBody)}`,
        );
      }
      fail(`${operationLabel} (${url}) returned invalid JSON: ${parseErrorDetails}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      fail(`${operationLabel} (${url}) timed out after ${timeoutMs}ms`);
    }

    const errorDetails = error instanceof Error ? error.message : String(error);
    fail(`${operationLabel} (${url}) request failed: ${createRedactedPreview(errorDetails)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileFile = args['profile-file'] ?? DEFAULT_PROFILE_FILE;
  const runtimeEnv = loadRuntimeEnv(profileFile);
  let timeoutSource = 'default value';
  let rawTimeoutMs = DEFAULT_TIMEOUT_MS;
  if (args['timeout-ms'] !== null && args['timeout-ms'] !== undefined) {
    timeoutSource = '--timeout-ms';
    rawTimeoutMs = args['timeout-ms'];
  } else if (
    runtimeEnv.DASHBOARD_TRUSTED_SESSION_TIMEOUT_MS !== null &&
    runtimeEnv.DASHBOARD_TRUSTED_SESSION_TIMEOUT_MS !== undefined
  ) {
    timeoutSource = 'DASHBOARD_TRUSTED_SESSION_TIMEOUT_MS';
    rawTimeoutMs = runtimeEnv.DASHBOARD_TRUSTED_SESSION_TIMEOUT_MS;
  }
  let timeoutMs;
  try {
    timeoutMs = normalizeTimeoutMs(rawTimeoutMs);
  } catch (error) {
    const errorDetails = error instanceof Error ? error.message : String(error);
    fail(`Invalid timeout value from ${timeoutSource}: ${String(rawTimeoutMs)} (${errorDetails})`);
  }
  const trustedSessionExchangePath = resolveTrustedSessionExchangePath(args, runtimeEnv);
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
  if (orgId !== null) {
    requestPayload.orgId = orgId;
  }
  if (email !== null) {
    requestPayload.email = email;
  }
  if (walletAddress !== null) {
    requestPayload.walletAddress = walletAddress;
  }
  const requestBody = JSON.stringify(requestPayload);
  const timestampSecondsStr = String(Math.floor(Date.now() / 1000));
  let nonce;
  try {
    nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to generate cryptographic nonce for trusted session exchange: ${message}`);
  }
  const bodySha256 = crypto.createHash('sha256').update(requestBody).digest('hex');
  const requestUrl = buildUrl(authBaseUrl, trustedSessionExchangePath);
  const canonicalString = buildServiceAuthCanonicalString({
    method: 'POST',
    path: requestUrl.pathname,
    query: '',
    bodySha256,
    timestamp: timestampSecondsStr,
    nonce,
  });
  const signature = signServiceAuthCanonicalString(trustedSessionKey.secret, canonicalString);

  const exchangeEnvelope = await fetchJson(requestUrl.href, {
    body: requestBody,
    timeoutMs,
    operation: 'trusted session exchange request',
    headers: {
      'X-Api-Key': trustedSessionKey.id,
      'X-Timestamp': timestampSecondsStr,
      'X-Nonce': nonce,
      'X-Signature': signature,
    },
  });

  const result = exchangeEnvelope?.data;
  if (!result?.sessionId) {
    fail(
      `trusted session exchange payload missing sessionId: ${createRedactedPreview(
        JSON.stringify(exchangeEnvelope),
      )}`,
    );
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
