import express from 'express';
import { AddressInfo } from 'node:net';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
jest.mock('../src/middleware/middleware', () => ({
  authMiddleware(req: express.Request, res: express.Response, _next: express.NextFunction) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
  },
  hmacMiddleware(_req: express.Request, _res: express.Response, next: express.NextFunction) {
    next();
  },
}));
import { createRouter } from '../src/api/routes';
import { oracleRateLimitPolicy } from '../src/httpSecurity';

async function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function request(baseUrl: string, path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, init);
}

describe('oracle rate-limit wiring', () => {
  test('mutation routes are throttled more tightly than health routes', async () => {
    const limiter = await createHttpRateLimiter({
      enabled: true,
      nodeEnv: 'development',
      keyPrefix: 'oracle-test',
      classifyRoute: oracleRateLimitPolicy,
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api/oracle',
      limiter.middleware,
      createRouter({} as never, async () => undefined),
    );

    try {
      await withServer(app, async (baseUrl) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const response = await request(baseUrl, '/api/oracle/release-stage1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeId: 'trade-1', requestId: 'req-1' }),
          });
          expect(response.status).toBe(401);
        }

        const blocked = await request(baseUrl, '/api/oracle/release-stage1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tradeId: 'trade-1', requestId: 'req-1' }),
        });
        expect(blocked.status).toBe(429);

        for (let attempt = 0; attempt < 21; attempt += 1) {
          const response = await request(baseUrl, '/api/oracle/health');
          expect(response.status).toBe(200);
        }
      });
    } finally {
      await limiter.close();
    }
  });
});
