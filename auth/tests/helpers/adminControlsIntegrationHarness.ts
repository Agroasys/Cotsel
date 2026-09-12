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

export function signedHeaders(input: {
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

export async function startAdminApp(pool: Pool) {
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
    adminController: new AdminController(
      createAdminService(profiles, 3600, createPostgresOperatorSignerStore(pool)),
    ),
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
