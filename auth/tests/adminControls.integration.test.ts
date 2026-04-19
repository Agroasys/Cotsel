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
import { createAdminService } from '../src/core/adminService';
import { createPostgresProfileStore } from '../src/core/profileStore';
import { createPostgresSessionStore } from '../src/core/sessionStore';
import { createSessionService } from '../src/core/sessionService';
import { AdminController } from '../src/api/adminController';
import { createRouter } from '../src/api/routes';
import { SessionController } from '../src/api/controller';

const POSTGRES_IMAGE = process.env.AUTH_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const API_KEY_ID = 'ops-admin-control-test';
const API_SECRET = 'admin-control-test-secret';
let dockerAvailable = true;

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

async function withPostgres(fn: (pool: Pool) => Promise<void>): Promise<void> {
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
      const schema = fs.readFileSync(path.resolve(__dirname, '../src/database/schema.sql'), 'utf8');
      await pool.query(schema);
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

function signedHeaders(input: {
  method: string;
  path: string;
  body: string;
  nonce: string;
  timestamp?: string;
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
    'X-Api-Key': API_KEY_ID,
    'X-Timestamp': timestamp,
    'X-Nonce': input.nonce,
    'X-Signature': signServiceAuthCanonicalString(API_SECRET, canonical),
  };
}

async function startAdminApp(pool: Pool) {
  const profiles = createPostgresProfileStore(pool);
  const sessions = createPostgresSessionStore(pool);
  const sessionService = createSessionService(sessions, profiles);
  const nonceStore = createPostgresNonceStore({
    tableName: 'auth_admin_control_nonces',
    query: (sql, params) => pool.query(sql, params),
  });
  const adminMiddleware = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: 300,
    nonceTtlSeconds: 600,
    lookupApiKey: (key) =>
      key === API_KEY_ID ? { id: API_KEY_ID, secret: API_SECRET, active: true } : undefined,
    consumeNonce: nonceStore.consume,
  });
  const router = createRouter(new SessionController(sessionService), sessionService, {
    adminController: new AdminController(createAdminService(profiles, 3600)),
    adminControlMiddleware: adminMiddleware,
  });
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

describe('admin controls persistence integration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'admin provisioning, break-glass, audit, replay, and revocation persist correctly',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const provisionPath = '/api/auth/v1/admin/profiles/provision';
          const provisionBody = JSON.stringify({
            accountId: 'agroasys-user:admin-1',
            role: 'admin',
            email: 'admin@example.com',
            orgId: 'ops',
            reason: 'SEC-1000 durable admin provisioning for integration proof',
          });
          const denied = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: {
              ...signedHeaders({
                method: 'POST',
                path: provisionPath,
                body: provisionBody,
                nonce: 'nonce-denied-1',
              }),
              'X-Api-Key': 'not-allowed-for-admin-control',
            },
            body: provisionBody,
          });
          expect(denied.status).toBe(401);

          const first = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: provisionBody,
              nonce: 'nonce-provision-1',
            }),
            body: provisionBody,
          });
          expect(first.status).toBe(201);

          const replay = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: provisionBody,
              nonce: 'nonce-provision-1',
            }),
            body: provisionBody,
          });
          expect(replay.status).toBe(401);

          const provisioned = await pool.query(
            `SELECT role, active FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:admin-1'],
          );
          expect(provisioned.rows[0]).toMatchObject({ role: 'admin', active: true });

          const session = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:admin-1',
            role: 'admin',
            email: 'admin@example.com',
          });

          const downgradeBody = JSON.stringify({
            accountId: 'agroasys-user:admin-1',
            role: 'buyer',
            reason: 'SEC-1001 durable admin revoked after integration proof',
          });
          const downgrade = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: downgradeBody,
              nonce: 'nonce-downgrade-1',
            }),
            body: downgradeBody,
          });
          expect(downgrade.status).toBe(201);
          await expect(app.sessionService.resolve(session.sessionId)).resolves.toBeNull();

          const durableAdminBody = JSON.stringify({
            accountId: 'agroasys-user:admin-2',
            role: 'admin',
            email: 'admin-2@example.com',
            reason: 'SEC-1003 durable admin provisioning before break-glass rejection proof',
          });
          const durableAdmin = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: durableAdminBody,
              nonce: 'nonce-provision-admin-2',
            }),
            body: durableAdminBody,
          });
          expect(durableAdmin.status).toBe(201);

          const grantPath = '/api/auth/v1/admin/break-glass/grant';
          const rejectedAdminGrantBody = JSON.stringify({
            accountId: 'agroasys-user:admin-2',
            baseRole: 'buyer',
            ttlSeconds: 300,
            reason: 'INC-1999 reject break-glass for durable admin integration proof',
          });
          const rejectedAdminGrant = await fetch(`${app.baseUrl}${grantPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: grantPath,
              body: rejectedAdminGrantBody,
              nonce: 'nonce-bg-admin-reject-1',
            }),
            body: rejectedAdminGrantBody,
          });
          expect(rejectedAdminGrant.status).toBe(409);

          const grantBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            baseRole: 'buyer',
            ttlSeconds: 300,
            reason: 'INC-2000 temporary admin integration proof',
          });
          const grant = await fetch(`${app.baseUrl}${grantPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: grantPath,
              body: grantBody,
              nonce: 'nonce-bg-grant-1',
            }),
            body: grantBody,
          });
          expect(grant.status).toBe(201);

          const breakGlassProfile = await pool.query(
            `SELECT role, break_glass_role, break_glass_expires_at
             FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );
          expect(breakGlassProfile.rows[0].role).toBe('buyer');
          expect(breakGlassProfile.rows[0].break_glass_role).toBe('admin');
          expect(breakGlassProfile.rows[0].break_glass_expires_at).toBeTruthy();

          const existingSupplierBody = JSON.stringify({
            accountId: 'agroasys-user:supplier-bg',
            role: 'supplier',
            reason: 'SEC-1004 durable supplier profile before break-glass base-role proof',
          });
          const existingSupplier = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: existingSupplierBody,
              nonce: 'nonce-provision-supplier-bg',
            }),
            body: existingSupplierBody,
          });
          expect(existingSupplier.status).toBe(201);

          const supplierGrantBody = JSON.stringify({
            accountId: 'agroasys-user:supplier-bg',
            baseRole: 'buyer',
            ttlSeconds: 300,
            reason: 'INC-2001 temporary admin keeps existing durable supplier base role',
          });
          const supplierGrant = await fetch(`${app.baseUrl}${grantPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: grantPath,
              body: supplierGrantBody,
              nonce: 'nonce-bg-supplier-grant-1',
            }),
            body: supplierGrantBody,
          });
          expect(supplierGrant.status).toBe(201);
          const supplierState = await pool.query(
            `SELECT role, break_glass_role
             FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:supplier-bg'],
          );
          expect(supplierState.rows[0]).toMatchObject({
            role: 'supplier',
            break_glass_role: 'admin',
          });

          const bgSession = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:bg-1',
            role: 'buyer',
            email: 'breakglass@example.com',
          });
          const issuedBreakGlassSession = await pool.query(
            `SELECT role FROM user_sessions WHERE session_id = $1`,
            [bgSession.sessionId],
          );
          expect(issuedBreakGlassSession.rows[0].role).toBe('admin');
          await pool.query(
            `UPDATE user_profiles SET break_glass_expires_at = NOW() - INTERVAL '1 second'
             WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );
          await expect(app.sessionService.resolve(bgSession.sessionId)).resolves.toBeNull();

          const reviewPath = '/api/auth/v1/admin/break-glass/review';
          const reviewBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            reason: 'INC-2000 reviewed expired temporary admin integration proof',
          });
          const review = await fetch(`${app.baseUrl}${reviewPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: reviewPath,
              body: reviewBody,
              nonce: 'nonce-bg-review-1',
            }),
            body: reviewBody,
          });
          expect(review.status).toBe(200);

          const postExpirySession = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:bg-1',
            role: 'buyer',
            email: 'breakglass@example.com',
          });
          const issuedBaseSession = await pool.query(
            `SELECT role FROM user_sessions WHERE session_id = $1`,
            [postExpirySession.sessionId],
          );
          expect(issuedBaseSession.rows[0].role).toBe('buyer');

          const deactivatePath = '/api/auth/v1/admin/profiles/deactivate';
          const deactivateBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            reason: 'SEC-1002 deactivate temporary admin test account',
          });
          const deactivate = await fetch(`${app.baseUrl}${deactivatePath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: deactivatePath,
              body: deactivateBody,
              nonce: 'nonce-deactivate-1',
            }),
            body: deactivateBody,
          });
          expect(deactivate.status).toBe(200);
          await expect(app.sessionService.resolve(postExpirySession.sessionId)).resolves.toBeNull();

          const audit = await pool.query(
            `SELECT action, previous_role, new_role, reason
             FROM auth_admin_audit_events ORDER BY created_at ASC`,
          );
          expect(audit.rows.map((row) => row.action)).toEqual(
            expect.arrayContaining([
              'profile_provisioned',
              'profile_role_updated',
              'break_glass_granted',
              'break_glass_expired',
              'break_glass_reviewed',
              'profile_deactivated',
            ]),
          );
          expect(audit.rows.every((row) => String(row.reason).length >= 8)).toBe(true);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );
});
