import express, { NextFunction, Request, Response } from 'express';
import { AddressInfo } from 'node:net';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import { createRouter } from '../src/api/routes';
import { authRateLimitPolicy } from '../src/httpSecurity';

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

async function request(baseUrl: string, path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, init);
}

function buildApp(): Promise<{ app: express.Express; close: () => Promise<void> }> {
  const sessionController = {
    async getSession(_req: Request, res: Response) {
      res.status(200).json({ success: true });
    },
    async refresh(_req: Request, res: Response) {
      res.status(200).json({ success: true });
    },
    async revoke(_req: Request, res: Response) {
      res.status(200).json({ success: true });
    },
    async exchangeTrustedSession(_req: Request, res: Response) {
      res.status(200).json({ success: true });
    },
  };
  const legacyWalletController = {
    async getChallenge(_req: Request, res: Response) {
      res.status(200).json({ success: true });
    },
    async login(_req: Request, res: Response) {
      res.status(200).json({ success: true });
    },
  };
  const sessionService = {
    async resolve() {
      return {
        sessionId: 'session-1',
        userId: 'user-1',
        role: 'admin',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };

  return createHttpRateLimiter({
    enabled: true,
    nodeEnv: 'development',
    keyPrefix: 'auth-test',
    classifyRoute: authRateLimitPolicy,
  }).then((limiter) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/auth/v1',
      limiter.middleware,
      createRouter(sessionController as never, sessionService as never, {
        legacyWalletController: legacyWalletController as never,
        trustedSessionExchangeMiddleware: (_req: Request, _res: Response, next: NextFunction) =>
          next(),
      }),
    );

    return {
      app,
      close: limiter.close,
    };
  });
}

describe('auth rate-limit wiring', () => {
  test('challenge route uses the tighter legacy-wallet throttle', async () => {
    const { app, close } = await buildApp();

    try {
      await withServer(app, async (baseUrl) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const response = await request(baseUrl, '/api/auth/v1/challenge?wallet=0x1234');
          expect(response.status).toBe(200);
        }

        const blocked = await request(baseUrl, '/api/auth/v1/challenge?wallet=0x1234');
        expect(blocked.status).toBe(429);
      });
    } finally {
      await close();
    }
  });

  test('session refresh uses the broader session throttle, not the legacy-wallet limit', async () => {
    const { app, close } = await buildApp();

    try {
      await withServer(app, async (baseUrl) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const response = await request(baseUrl, '/api/auth/v1/session/refresh', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer session-1',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          expect(response.status).toBe(200);
        }

        const blocked = await request(baseUrl, '/api/auth/v1/session/refresh', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer session-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });
        expect(blocked.status).toBe(429);
      });
    } finally {
      await close();
    }
  });
});
