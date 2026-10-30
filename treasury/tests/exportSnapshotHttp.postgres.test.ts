import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  signServiceAuthCanonicalString,
} from '../src/auth/serviceAuth';

const describePostgres = process.env.TREASURY_POSTGRES_TESTS === 'true' ? describe : describe.skip;

describePostgres('snapshot exports over signed HTTP', () => {
  test('binds creation, replay, status and entry access to the named caller', async () => {
    const suffix = randomBytes(6).toString('hex');
    const database = `treasury_http_${suffix}`;
    const runtimeRole = `treasury_http_${suffix}`;
    const connection = {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    };
    const admin = new Pool({ ...connection, database: 'postgres' });
    let db: Pool | undefined;
    let server: Server | undefined;
    let closeService: (() => Promise<void>) | undefined;
    try {
      await admin.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
      await admin.query(`CREATE DATABASE "${database}"`);
      db = new Pool({
        ...connection,
        database,
        options: `-c app.service_name=treasury -c app.runtime_db_user=${runtimeRole}`,
      });
      await runVersionedMigrations({
        pool: db,
        serviceName: 'treasury',
        manifestPath: path.resolve(__dirname, '../src/database/migrations.json'),
        runtimeDbUser: runtimeRole,
      });
      process.env.PORT = '3200';
      process.env.DB_HOST = connection.host;
      process.env.DB_PORT = String(connection.port);
      process.env.DB_NAME = database;
      process.env.DB_USER = connection.user;
      process.env.DB_PASSWORD = connection.password;
      process.env.INDEXER_GRAPHQL_URL = 'http://127.0.0.1:3100/graphql';
      delete process.env.RPC_URL;
      delete process.env.SETTLEMENT_RUNTIME;
      delete process.env.RECONCILIATION_DB_NAME;
      ({ closeConnection: closeService } = await import('../src/database/connection'));
      const { TreasuryController } = await import('../src/api/controller');
      const { createRouter } = await import('../src/api/routes');
      const auth = createServiceAuthMiddleware({
        enabled: true,
        maxSkewSeconds: 300,
        nonceTtlSeconds: 600,
        lookupApiKey: (id) =>
          ['svc-a', 'svc-b'].includes(id)
            ? { id, secret: 'fixture-secret', active: true }
            : undefined,
        consumeNonce: async () => true,
        nowSeconds: () => 1700000000,
      });
      const app = express();
      app.use(
        express.json({
          verify: (req, _res, bytes) => {
            (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
          },
        }),
      );
      app.use('/api/treasury/v1', createRouter(new TreasuryController(), { authMiddleware: auth }));
      server = await new Promise<Server>((resolve) => {
        const listener = app.listen(0, () => resolve(listener));
      });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const request = async (
        method: string,
        route: string,
        caller: string,
        body = '',
        key?: string,
      ) => {
        const requestPath = `/api/treasury/v1${route}`;
        const timestamp = '1700000000';
        const nonce = randomUUID();
        const canonical = buildServiceAuthCanonicalString({
          method,
          path: requestPath,
          query: '',
          bodySha256: createHash('sha256').update(body).digest('hex'),
          timestamp,
          nonce,
        });
        return fetch(base + requestPath, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-api-key': caller,
            'x-agroasys-timestamp': timestamp,
            'x-agroasys-nonce': nonce,
            'x-agroasys-signature': signServiceAuthCanonicalString('fixture-secret', canonical),
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          ...(body ? { body } : {}),
        });
      };
      const body = JSON.stringify({ cutoff: '2010-01-01T00:00:00.000Z' });
      const created = await request('POST', '/exports', 'svc-a', body, 'http-key');
      expect(created.status).toBe(202);
      const payload = (await created.json()) as { data: { id: string } };
      const id = payload.data.id;
      const waitForFailure = async (minimumAttempt: number): Promise<void> => {
        for (let poll = 0; poll < 100; poll += 1) {
          const row = await db!.query(
            'SELECT status, attempt FROM treasury_export_jobs WHERE id=$1',
            [id],
          );
          if (row.rows[0]?.status === 'FAILED' && row.rows[0]?.attempt >= minimumAttempt) {
            await new Promise((resolve) => setImmediate(resolve));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Export did not reach the expected failed attempt');
      };
      await waitForFailure(1);
      const replay = await request('POST', '/exports', 'svc-a', body, 'http-key');
      expect(replay.status).toBe(202);
      expect(((await replay.json()) as { data: { id: string } }).data.id).toBe(id);
      expect(
        (
          await request(
            'POST',
            '/exports',
            'svc-a',
            JSON.stringify({ cutoff: '2011-01-01T00:00:00.000Z' }),
            'http-key',
          )
        ).status,
      ).toBe(409);
      expect((await request('GET', `/exports/${id}`, 'svc-b')).status).toBe(404);
      expect((await request('GET', `/exports/${id}/entries`, 'svc-a')).status).toBe(409);
      const unsigned = await fetch(`${base}/api/treasury/v1/exports/${id}`);
      expect(unsigned.status).toBe(401);
      await waitForFailure(2);
      const ownStatus = await request('GET', `/exports/${id}`, 'svc-a');
      expect(ownStatus.status).toBe(200);
      expect(((await ownStatus.json()) as { data: { failureCode: string } }).data.failureCode).toBe(
        'CHAIN_ANCHOR_UNAVAILABLE',
      );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      await closeService?.();
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  }, 60000);
});
