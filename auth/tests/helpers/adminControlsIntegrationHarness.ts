/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Pool } from 'pg';
import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  signServiceAuthCanonicalString,
} from '@agroasys/shared-auth/serviceAuth';
import { createPostgresNonceStore } from '@agroasys/shared-auth/nonceStore';
import { createAdminService } from '../../src/core/adminService';
import { createPostgresAdminAuthorityStore } from '../../src/core/adminAuthorityStore';
import { createExchangeAuthorityLookup } from '../../src/core/exchangeAuthority';
import { createPostgresProfileStore } from '../../src/core/profileStore';
import { createPostgresSessionStore } from '../../src/core/sessionStore';
import { createSessionService } from '../../src/core/sessionService';
import { createPostgresOperatorSignerStore } from '../../src/core/operatorSignerStore';
import { AdminController } from '../../src/api/adminController';
import { createRouter } from '../../src/api/routes';
import { SessionController } from '../../src/api/controller';

const POSTGRES_IMAGE = process.env.AUTH_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const API_KEY_ID = 'ops-admin-control-test';
const API_SECRET = 'admin-control-test-secret';
const HUMAN_PRINCIPAL_ID = 'agroasys-user:ops-admin-control-test';
/** The Cotsel environment the harness runs auth in; admin grants bind to it. */
export const TEST_ENVIRONMENT = 'test';
/** A second admin-control key, held by a different human, for two-person approval. */
export const ADMIN_CONTROL_APPROVER = {
  id: 'ops-admin-control-approver',
  secret: 'admin-control-approver-secret',
  humanPrincipalId: 'agroasys-user:ops-admin-control-approver',
} as const;
export let dockerAvailable = true;

try {
  execFileSync('docker', ['version'], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch {
  dockerAvailable = false;
}

function docker(args: string[], options: Parameters<typeof execFileSync>[2] = {}): string {
  return String(
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }),
  ).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(['exec', containerName, 'pg_isready', '-U', 'postgres']);
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await sleep(1000);
    }
  }
}

async function waitForPostgresConnection(port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = new Pool({
      host: '127.0.0.1',
      port,
      database: 'auth_test',
      user: 'postgres',
      password: 'postgres',
      connectionTimeoutMillis: 1000,
      max: 1,
    });
    try {
      await probe.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await sleep(1000);
    } finally {
      await probe.end().catch(() => undefined);
    }
  }
}

export async function withPostgres(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const containerName = `cotsel-auth-admin-test-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=auth_test',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);

  try {
    await waitForPostgres(containerName);
    const port = Number.parseInt(docker(['port', containerName, '5432/tcp']).split(':').pop()!, 10);
    await waitForPostgresConnection(port);
    const pool = new Pool({
      host: '127.0.0.1',
      port,
      database: 'auth_test',
      user: 'postgres',
      password: 'postgres',
    });
    try {
      await pool.query("SET app.service_name = 'auth'");
      const schema = fs.readFileSync(
        path.resolve(__dirname, '../../src/database/schema.sql'),
        'utf8',
      );
      await pool.query(schema);
      const signerMigration = fs.readFileSync(
        path.resolve(__dirname, '../../src/database/schema/002_operator_signer_register.sql'),
        'utf8',
      );
      await pool.query(signerMigration);
      const signerApprovalMigration = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../src/database/schema/003_operator_signer_two_person_activation.sql',
        ),
        'utf8',
      );
      await pool.query(signerApprovalMigration);
      const sessionLineageMigration = fs.readFileSync(
        path.resolve(__dirname, '../../src/database/schema/004_session_token_hash_lineage.sql'),
        'utf8',
      );
      await pool.query(sessionLineageMigration);
      await pool.query(
        fs.readFileSync(
          path.resolve(__dirname, '../../src/database/schema/005_admin_authority_changes.sql'),
          'utf8',
        ),
      );
      await fn(pool);
    } finally {
      await pool.end();
    }
  } finally {
    try {
      docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Trusted-exchange keys wired by {@link startAdminApp}, with their role ceilings. */
export const EXCHANGE_KEYS = {
  member: {
    id: 'exchange-member',
    secret: 'exchange-member-secret',
    roles: ['buyer', 'supplier'],
    orgId: null,
  },
  operator: {
    id: 'exchange-operator',
    secret: 'exchange-operator-secret',
    roles: ['admin'],
    orgId: null,
  },
  pinned: {
    id: 'exchange-pinned',
    secret: 'exchange-pinned-secret',
    roles: ['buyer', 'supplier', 'admin'],
    orgId: 'org-a',
  },
} as const;

export function signedHeaders(input: {
  method: string;
  path: string;
  body: string;
  nonce: string;
  timestamp?: string;
  apiKey?: { id: string; secret: string };
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const bodySha256 = Buffer.from(input.body).toString('utf8');
  const canonical = buildServiceAuthCanonicalString({
    method: input.method,
    path: input.path,
    query: '',
    bodySha256: crypto.createHash('sha256').update(bodySha256).digest('hex'),
    timestamp,
    nonce: input.nonce,
  });
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Api-Key': input.apiKey?.id ?? API_KEY_ID,
    'X-Timestamp': timestamp,
    'X-Nonce': input.nonce,
    'X-Signature': signServiceAuthCanonicalString(input.apiKey?.secret ?? API_SECRET, canonical),
  };
}

export async function startAdminApp(pool: Pool) {
  const profiles = createPostgresProfileStore(pool, TEST_ENVIRONMENT);
  const sessions = createPostgresSessionStore(pool, TEST_ENVIRONMENT);
  const sessionService = createSessionService(sessions, profiles, {
    ttlSeconds: 3600,
    absoluteLifetimeSeconds: 86400,
  });
  const nonceStore = createPostgresNonceStore({
    tableName: 'auth_admin_control_nonces',
    query: (sql, params) => pool.query(sql, params),
  });
  const adminMiddleware = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: 300,
    nonceTtlSeconds: 600,
    lookupApiKey: (key) => {
      if (key === API_KEY_ID) {
        return {
          id: API_KEY_ID,
          secret: API_SECRET,
          active: true,
          humanPrincipalId: HUMAN_PRINCIPAL_ID,
        };
      }
      return key === ADMIN_CONTROL_APPROVER.id
        ? { ...ADMIN_CONTROL_APPROVER, active: true }
        : undefined;
    },
    consumeNonce: nonceStore.consume,
  });
  const exchangeKeys = Object.values(EXCHANGE_KEYS);
  const exchangeNonceStore = createPostgresNonceStore({
    tableName: 'trusted_session_exchange_nonces',
    query: (sql, params) => pool.query(sql, params),
  });
  const trustedSessionExchangeMiddleware = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: 300,
    nonceTtlSeconds: 600,
    lookupApiKey: (key) => {
      const match = exchangeKeys.find((candidate) => candidate.id === key);
      return match ? { id: match.id, secret: match.secret, active: true } : undefined;
    },
    consumeNonce: exchangeNonceStore.consume,
  });
  const exchangeAuthorityFor = createExchangeAuthorityLookup(
    JSON.stringify(exchangeKeys.map(({ id, secret }) => ({ id, secret, active: true }))),
    JSON.stringify(
      Object.fromEntries(exchangeKeys.map(({ id, roles, orgId }) => [id, { roles, orgId }])),
    ),
  );
  const router = createRouter(
    new SessionController(sessionService, 86400, exchangeAuthorityFor),
    sessionService,
    {
      adminController: new AdminController(
        createAdminService(profiles, 3600, createPostgresOperatorSignerStore(pool), {
          store: createPostgresAdminAuthorityStore(pool, TEST_ENVIRONMENT),
          maxGrantTtlSeconds: 2592000,
        }),
      ),
      adminControlMiddleware: adminMiddleware,
      trustedSessionExchangeMiddleware,
    },
  );
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use('/api/auth/v1', router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind admin test server');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    sessionService,
  };
}

let controlNonce = 0;

/** Sends a signed admin-control POST, by default as the proposing human. */
export async function postAdminControl(
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
  apiKey?: { id: string; secret: string },
): Promise<{ status: number; json: { data?: Record<string, unknown>; message?: string } }> {
  const body = JSON.stringify(payload);
  controlNonce += 1;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: signedHeaders({
      method: 'POST',
      path,
      body,
      nonce: `admin-control-${process.pid}-${Date.now()}-${controlNonce}`,
      apiKey,
    }),
    body,
  });
  return { status: response.status, json: await response.json() };
}

/**
 * Makes `accountId` a durable administrator the only way auth allows: one human
 * proposes the grant and a second human approves its evidence digest.
 */
export async function grantAdminAuthority(
  baseUrl: string,
  accountId: string,
  options: { orgId?: string | null; expiresAt?: string } = {},
): Promise<Record<string, unknown>> {
  const proposed = await postAdminControl(baseUrl, '/api/auth/v1/admin/authority-changes/propose', {
    accountId,
    change: 'grant',
    environment: TEST_ENVIRONMENT,
    orgId: options.orgId ?? null,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    approvalTicket: 'SEC-2000',
    reason: 'Two-person administrator grant for integration proof',
  });
  if (proposed.status !== 201) {
    throw new Error(`admin grant proposal failed: ${proposed.status} ${proposed.json.message}`);
  }
  const approved = await postAdminControl(
    baseUrl,
    '/api/auth/v1/admin/authority-changes/approve',
    {
      changeId: proposed.json.data!.changeId,
      evidenceDigest: proposed.json.data!.evidenceDigest,
      reason: 'Second human approves administrator grant',
    },
    ADMIN_CONTROL_APPROVER,
  );
  if (approved.status !== 200) {
    throw new Error(`admin grant approval failed: ${approved.status} ${approved.json.message}`);
  }
  return approved.json.data!;
}

/** Returns `accountId` to `resultingRole` through a two-person revocation. */
export async function revokeAdminAuthority(
  baseUrl: string,
  accountId: string,
  resultingRole: 'buyer' | 'supplier' = 'buyer',
): Promise<Record<string, unknown>> {
  const proposed = await postAdminControl(baseUrl, '/api/auth/v1/admin/authority-changes/propose', {
    accountId,
    change: 'revoke',
    environment: TEST_ENVIRONMENT,
    resultingRole,
    approvalTicket: 'SEC-2001',
    reason: 'Two-person administrator revocation for integration proof',
  });
  if (proposed.status !== 201) {
    throw new Error(
      `admin revocation proposal failed: ${proposed.status} ${proposed.json.message}`,
    );
  }
  const approved = await postAdminControl(
    baseUrl,
    '/api/auth/v1/admin/authority-changes/approve',
    {
      changeId: proposed.json.data!.changeId,
      evidenceDigest: proposed.json.data!.evidenceDigest,
      reason: 'Second human approves administrator revocation',
    },
    ADMIN_CONTROL_APPROVER,
  );
  if (approved.status !== 200) {
    throw new Error(
      `admin revocation approval failed: ${approved.status} ${approved.json.message}`,
    );
  }
  return approved.json.data!;
}
