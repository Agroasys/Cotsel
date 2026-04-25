#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { DEFAULT_TIMEOUT_MS, normalizeTimeoutMs } from './lib/dashboard-operator-session.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const {
  buildServiceAuthCanonicalString,
  signServiceAuthCanonicalString,
} = require('../shared-auth/src/serviceAuth.js');

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_AUTH_BASE_URL = 'https://cotsel.sys.agroasys.com/api/auth/v1';
const DEFAULT_GATEWAY_BASE_URL = 'https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1';
const DEFAULT_WALLET = '0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a';
const DEFAULT_ACCOUNT_ID = 'demo-admin-001';
const DEFAULT_EMAIL = 'demo-admin-001@agroasys.local';
const DEFAULT_SIGNER_ENVIRONMENT = 'production';
const REQUIRED_AUTH_TABLES = ['operator_capability_bindings', 'operator_signer_bindings'];

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line)) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/u);
    if (!match) {
      continue;
    }
    let value = match[2];
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

function runtimeEnv() {
  return {
    ...loadEnvFile(path.join(ROOT_DIR, '.env')),
    ...loadEnvFile(path.join(ROOT_DIR, '.env.runtime')),
    ...loadEnvFile(path.join(ROOT_DIR, '.env.staging-e2e-real')),
    ...process.env,
  };
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`missing required env var: ${name}`);
  }
  return value.trim();
}

function optionalEnv(env, name, fallback) {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function parseApiKeys(rawValue, envName) {
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      fail(`${envName} must be a JSON array`);
    }
    return parsed;
  } catch (error) {
    fail(
      `${envName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function pickActiveApiKey(keys, preferredId, envName) {
  const key = preferredId
    ? keys.find((candidate) => candidate?.id === preferredId && candidate.active === true)
    : keys.find((candidate) => candidate?.active === true);
  if (!key?.id || !key?.secret) {
    fail(`no active API key found in ${envName}`);
  }
  return key;
}

function buildUrl(baseUrl, pathname) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  return new URL(pathname.replace(/^\/+/u, ''), base);
}

function safePreview(payload) {
  const serialized = JSON.stringify(payload);
  if (!serialized) {
    return 'null';
  }
  return serialized.length <= 500 ? serialized : `${serialized.slice(0, 500)}...`;
}

async function fetchJson(url, options = {}) {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      fail(`${url} returned HTTP ${response.status}: ${safePreview(payload)}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      fail(`${url} timed out after ${timeoutMs}ms`);
    }
    fail(`${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function serviceAuthHeaders({ key, method, url, body }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const parsedUrl = new URL(url);
  const bodySha256 = crypto
    .createHash('sha256')
    .update(body ?? '')
    .digest('hex');
  const canonical = buildServiceAuthCanonicalString({
    method,
    path: parsedUrl.pathname,
    query: parsedUrl.search ? parsedUrl.search.slice(1) : '',
    bodySha256,
    timestamp,
    nonce,
  });
  return {
    'X-Api-Key': key.id,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signServiceAuthCanonicalString(key.secret, canonical),
  };
}

async function withPool(connectionString, fn) {
  const pool = new Pool({ connectionString });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function assertAuthSchema(connectionString) {
  await withPool(connectionString, async (pool) => {
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name ASC`,
      [REQUIRED_AUTH_TABLES],
    );
    const present = new Set(result.rows.map((row) => row.table_name));
    const missing = REQUIRED_AUTH_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      fail(`auth schema missing required tables: ${missing.join(', ')}`);
    }
  });
}

async function assertWalletProfile(connectionString, walletAddress) {
  await withPool(connectionString, async (pool) => {
    const result = await pool.query(
      `SELECT account_id
       FROM user_profiles
       WHERE lower(wallet_address) = lower($1)
         AND active = TRUE
       LIMIT 1`,
      [walletAddress],
    );
    if (!result.rows[0]) {
      fail(`target operator wallet is not linked to an active auth profile: ${walletAddress}`);
    }
  });
}

async function assertPreparedSigningPayload(connectionString, actionId) {
  await withPool(connectionString, async (pool) => {
    const result = await pool.query(
      `SELECT status, category, prepared_signing_payload
       FROM governance_actions
       WHERE action_id = $1`,
      [actionId],
    );
    const row = result.rows[0];
    if (!row) {
      fail(`prepared governance action was not persisted: ${actionId}`);
    }
    if (row.status !== 'prepared' || row.category !== 'pause') {
      fail(`prepared governance action has unexpected state: ${safePreview(row)}`);
    }
    if (!row.prepared_signing_payload?.preparedPayloadHash) {
      fail(`prepared_signing_payload was not persisted for action ${actionId}`);
    }
  });
}

async function postServiceAuthJson({ baseUrl, pathname, key, body, timeoutMs }) {
  const url = buildUrl(baseUrl, pathname).toString();
  const serialized = JSON.stringify(body);
  return fetchJson(url, {
    method: 'POST',
    body: serialized,
    timeoutMs,
    headers: serviceAuthHeaders({
      key,
      method: 'POST',
      url,
      body: serialized,
    }),
  });
}

async function main() {
  const env = runtimeEnv();
  const timeoutMs = normalizeTimeoutMs(
    optionalEnv(env, 'COTSEL_489_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  );
  const authBaseUrl = optionalEnv(env, 'COTSEL_489_AUTH_BASE_URL', DEFAULT_AUTH_BASE_URL);
  const gatewayBaseUrl = optionalEnv(env, 'COTSEL_489_GATEWAY_BASE_URL', DEFAULT_GATEWAY_BASE_URL);
  const accountId = optionalEnv(env, 'COTSEL_489_ACCOUNT_ID', DEFAULT_ACCOUNT_ID);
  const walletAddress = optionalEnv(env, 'COTSEL_489_WALLET_ADDRESS', DEFAULT_WALLET);
  const email = optionalEnv(env, 'COTSEL_489_EMAIL', DEFAULT_EMAIL);
  const signerEnvironment = optionalEnv(
    env,
    'COTSEL_489_SIGNER_ENVIRONMENT',
    DEFAULT_SIGNER_ENVIRONMENT,
  );
  const authDatabaseUrl = requiredEnv(env, 'COTSEL_489_AUTH_DATABASE_URL');
  const gatewayDatabaseUrl = requiredEnv(env, 'COTSEL_489_GATEWAY_DATABASE_URL');
  const adminKey = pickActiveApiKey(
    parseApiKeys(
      requiredEnv(env, 'AUTH_ADMIN_CONTROL_API_KEYS_JSON'),
      'AUTH_ADMIN_CONTROL_API_KEYS_JSON',
    ),
    optionalEnv(env, 'COTSEL_489_ADMIN_CONTROL_API_KEY_ID', ''),
    'AUTH_ADMIN_CONTROL_API_KEYS_JSON',
  );
  const trustedKey = pickActiveApiKey(
    parseApiKeys(
      requiredEnv(env, 'TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON'),
      'TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON',
    ),
    optionalEnv(env, 'COTSEL_489_TRUSTED_SESSION_API_KEY_ID', ''),
    'TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON',
  );

  await assertAuthSchema(authDatabaseUrl);

  await postServiceAuthJson({
    baseUrl: authBaseUrl,
    pathname: '/admin/profiles/provision',
    key: adminKey,
    timeoutMs,
    body: {
      accountId,
      role: 'admin',
      email,
      walletAddress,
      capabilities: ['governance:write', 'compliance:write'],
      capabilityTicketRef: 'COTSEL-489',
      reason: 'Cotsel#489 staging rehearsal admin capability provisioning',
    },
  });
  await assertWalletProfile(authDatabaseUrl, walletAddress);

  await postServiceAuthJson({
    baseUrl: authBaseUrl,
    pathname: '/admin/signers/provision',
    key: adminKey,
    timeoutMs,
    body: {
      accountId,
      walletAddress,
      actionClass: 'governance',
      environment: signerEnvironment,
      ticketRef: 'COTSEL-489',
      reason: 'Cotsel#489 prepare-only governance signer provisioning',
      notes: 'Base Sepolia prepare-only validation; do not broadcast pause.',
    },
  });

  const sessionEnvelope = await postServiceAuthJson({
    baseUrl: authBaseUrl,
    pathname: '/session/exchange/agroasys',
    key: trustedKey,
    timeoutMs,
    body: {
      accountId,
      role: 'admin',
      email,
      walletAddress,
    },
  });
  const sessionId = sessionEnvelope?.data?.sessionId;
  if (!sessionId) {
    fail(`trusted session exchange response missing sessionId: ${safePreview(sessionEnvelope)}`);
  }

  const capabilitiesEnvelope = await fetchJson(buildUrl(gatewayBaseUrl, '/auth/capabilities'), {
    timeoutMs,
    headers: {
      Authorization: `Bearer ${sessionId}`,
    },
  });
  const capabilities = capabilitiesEnvelope?.data?.subject?.capabilities ?? [];
  if (!capabilities.includes('governance:write')) {
    fail(`gateway capabilities missing governance:write: ${safePreview(capabilitiesEnvelope)}`);
  }
  if (capabilitiesEnvelope?.data?.actions?.governanceWrite !== true) {
    fail(`gateway governanceWrite is not true: ${safePreview(capabilitiesEnvelope)}`);
  }

  const prepareEnvelope = await fetchJson(buildUrl(gatewayBaseUrl, '/governance/pause/prepare'), {
    method: 'POST',
    timeoutMs,
    headers: {
      Authorization: `Bearer ${sessionId}`,
      'Idempotency-Key': `cotsel-489-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      signerWallet: walletAddress,
      audit: {
        reason:
          'Cotsel#489 Base Sepolia rehearsal prepare-only proof. Do not broadcast or execute pause.',
        ticketRef: 'COTSEL-489',
        evidenceLinks: [
          {
            kind: 'ticket',
            uri: 'https://github.com/Agroasys/Cotsel/issues/489',
            note: 'Prepare-only rehearsal readiness proof',
          },
        ],
      },
    }),
  });
  const prepared = prepareEnvelope?.data;
  if (
    prepareEnvelope?.success !== true ||
    prepared?.status !== 'prepared' ||
    prepared?.category !== 'pause' ||
    prepared?.signing?.chainId !== 84532 ||
    prepared?.signing?.contractMethod !== 'pause' ||
    prepared?.signing?.txRequest?.data !== '0x8456cb59' ||
    !prepared?.signing?.preparedPayloadHash
  ) {
    fail(
      `prepare-only governance response did not match #489 expectations: ${safePreview(prepareEnvelope)}`,
    );
  }

  await assertPreparedSigningPayload(gatewayDatabaseUrl, prepared.actionId);

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        accountId,
        walletAddress,
        signerEnvironment,
        capabilities: capabilities.sort(),
        preparedActionId: prepared.actionId,
        preparedPayloadHash: prepared.signing.preparedPayloadHash,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
