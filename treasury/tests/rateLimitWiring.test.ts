import express from 'express';
import { AddressInfo } from 'node:net';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import { createRouter } from '../src/api/routes';
import { treasuryRateLimitPolicy } from '../src/httpSecurity';

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

describe('treasury rate-limit wiring', () => {
  test('write routes use the tighter write bucket while reads keep the read allowance', async () => {
    const limiter = await createHttpRateLimiter({
      enabled: true,
      nodeEnv: 'development',
      keyPrefix: 'treasury-test',
      classifyRoute: treasuryRateLimitPolicy,
    });

    const controller = {
      async ingest(_req: express.Request, res: express.Response) {
        res.status(200).json({ success: true });
      },
      async listEntries(_req: express.Request, res: express.Response) {
        res.status(200).json({ success: true });
      },
      async appendState(_req: express.Request, res: express.Response) {
        res.status(200).json({ success: true });
      },
      async upsertBankConfirmation(_req: express.Request, res: express.Response) {
        res.status(200).json({ success: true });
      },
      async upsertDeposit(_req: express.Request, res: express.Response) {
        res.status(200).json({ success: true });
      },
      async exportEntries(_req: express.Request, res: express.Response) {
        res.status(200).json({ success: true });
      },
    };

    const app = express();
    app.use(express.json());
    app.use('/api/treasury/v1', limiter.middleware, createRouter(controller as never));

    try {
      await withServer(app, async (baseUrl) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const response = await request(baseUrl, '/api/treasury/v1/deposits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          expect(response.status).toBe(200);
        }

        const writeBlocked = await request(baseUrl, '/api/treasury/v1/deposits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(writeBlocked.status).toBe(429);

        for (let attempt = 0; attempt < 60; attempt += 1) {
          const response = await request(baseUrl, '/api/treasury/v1/entries');
          expect(response.status).toBe(200);
        }

        const readBlocked = await request(baseUrl, '/api/treasury/v1/entries');
        expect(readBlocked.status).toBe(429);
      });
    } finally {
      await limiter.close();
    }
  });
});
