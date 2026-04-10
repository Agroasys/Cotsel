import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { RequestHandler } from 'express';
import { RicardianController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';

function buildAuthMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.header('x-test-auth') === 'ok') {
      next();
      return;
    }

    res.status(401).json({ success: false, error: 'Unauthorized' });
  };
}

describe('ricardian router auth scope', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());

    const controller = {
      createHash: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { created: true } });
      },
      getHash: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { hash: 'ok' } });
      },
    } as unknown as RicardianController;

    app.use(
      '/api/ricardian/v1',
      createRouter(controller, { authMiddleware: buildAuthMiddleware() }),
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test('unauthenticated read route is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/ricardian/v1/hash/${'a'.repeat(64)}`);
    expect(response.status).toBe(401);
  });

  test('authenticated read route succeeds', async () => {
    const response = await fetch(`${baseUrl}/api/ricardian/v1/hash/${'a'.repeat(64)}`, {
      headers: {
        'x-test-auth': 'ok',
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
      }),
    );
  });
});
