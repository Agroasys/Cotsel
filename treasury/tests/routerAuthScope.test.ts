import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { RequestHandler } from 'express';
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

describe('treasury router auth scope', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());

    const controller = {
      ingest: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { ingested: true } });
      },
      listEntries: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
      appendState: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { updated: true } });
      },
      upsertBankConfirmation: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { confirmed: true } });
      },
      upsertDeposit: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { stored: true } });
      },
      exportEntries: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
    };

    app.use('/api/treasury/v1', createRouter(controller as any, { authMiddleware: buildAuthMiddleware() }));

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
    const response = await fetch(`${baseUrl}/api/treasury/v1/entries`);
    expect(response.status).toBe(401);
  });

  test('authenticated read route succeeds', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/entries`, {
      headers: {
        'x-test-auth': 'ok',
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
      })
    );
  });

  test('unauthenticated deposit write route is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/deposits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ rampReference: 'ramp-1' }),
    });

    expect(response.status).toBe(401);
  });

  test('unauthenticated bank confirmation route is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/entries/1/bank-confirmation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ bankReference: 'bank-1' }),
    });

    expect(response.status).toBe(401);
  });
});
