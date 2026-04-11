import express, { Router } from 'express';
import { AddressInfo } from 'node:net';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import { createApp } from '../src/app';
import { gatewayRateLimitPolicy } from '../src/httpSecurity';

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

describe('gateway rate-limit wiring', () => {
  test('read routes use the read bucket while system routes keep the higher system allowance', async () => {
    const limiter = await createHttpRateLimiter({
      enabled: true,
      nodeEnv: 'development',
      keyPrefix: 'gateway-test',
      classifyRoute: gatewayRateLimitPolicy,
    });

    const extraRouter = Router();
    extraRouter.get('/demo', (_req, res) => {
      res.status(200).json({ success: true });
    });

    const app = createApp(
      {
        corsAllowedOrigins: [],
        corsAllowNoOrigin: false,
      } as never,
      {
        version: '1.0.0-test',
        commitSha: 'deadbeef',
        buildTime: '2026-04-09T00:00:00.000Z',
        readinessCheck: async () => [],
        requestRateLimitMiddleware: limiter.middleware,
        extraRouter,
      },
    );

    try {
      await withServer(app, async (baseUrl) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const response = await request(baseUrl, '/api/dashboard-gateway/v1/demo');
          expect(response.status).toBe(200);
        }

        const readBlocked = await request(baseUrl, '/api/dashboard-gateway/v1/demo');
        expect(readBlocked.status).toBe(429);

        for (let attempt = 0; attempt < 61; attempt += 1) {
          const response = await request(baseUrl, '/api/dashboard-gateway/v1/version');
          expect(response.status).toBe(200);
        }
      });
    } finally {
      await limiter.close();
    }
  });

  test('write routes use the tighter write bucket', async () => {
    const limiter = await createHttpRateLimiter({
      enabled: true,
      nodeEnv: 'development',
      keyPrefix: 'gateway-test',
      classifyRoute: gatewayRateLimitPolicy,
    });

    const extraRouter = Router();
    extraRouter.post('/demo', (_req, res) => {
      res.status(200).json({ success: true });
    });

    const app = createApp(
      {
        corsAllowedOrigins: [],
        corsAllowNoOrigin: false,
      } as never,
      {
        version: '1.0.0-test',
        commitSha: 'deadbeef',
        buildTime: '2026-04-09T00:00:00.000Z',
        readinessCheck: async () => [],
        requestRateLimitMiddleware: limiter.middleware,
        extraRouter,
      },
    );

    try {
      await withServer(app, async (baseUrl) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const response = await request(baseUrl, '/api/dashboard-gateway/v1/demo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          expect(response.status).toBe(200);
        }

        const blocked = await request(baseUrl, '/api/dashboard-gateway/v1/demo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(blocked.status).toBe(429);
      });
    } finally {
      await limiter.close();
    }
  });
});
