import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createRouter } from '../src/api/routes';
import { generateRequestHash } from '../src/utils/crypto';
import { consumeHmacNonce } from '../src/database/queries';

jest.mock('../src/config', () => ({
  config: {
    apiKey: 'test-api-key',
    hmacSecret: 'test-hmac-secret',
    hmacNonceTtlSeconds: 600,
  },
}));

jest.mock('../src/database/queries', () => ({
  consumeHmacNonce: jest.fn(),
}));

function createSignedHeaders(
  body: Record<string, unknown>,
  overrides?: {
    timestamp?: string;
    signature?: string;
    nonce?: string;
    authorization?: string;
  },
) {
  const timestamp = overrides?.timestamp ?? Date.now().toString();
  const authorization = overrides?.authorization ?? 'Bearer test-api-key';
  const bodyText = JSON.stringify(body);
  const signature =
    overrides?.signature ?? generateRequestHash(timestamp, bodyText, 'test-hmac-secret');

  const headers: Record<string, string> = {
    authorization,
    'content-type': 'application/json',
    'x-timestamp': timestamp,
    'x-signature': signature,
  };

  if (overrides?.nonce !== undefined) {
    headers['x-nonce'] = overrides.nonce;
  }

  return headers;
}

describe('oracle authenticated routes', () => {
  const mockConsumeHmacNonce = consumeHmacNonce as jest.MockedFunction<typeof consumeHmacNonce>;
  let server: Server;
  let baseUrl: string;
  const controller = {
    releaseStage1: async (req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        route: 'release-stage1',
        requestHash: req.hmacSignature,
        nonce: req.hmacNonce,
      });
    },
    confirmArrival: async (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
    finalizeTrade: async (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
    redriveTrigger: async (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
    approveTrigger: async (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
    rejectTrigger: async (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const app = express();
    app.use(express.json());
    app.use('/api/oracle', createRouter(controller as never));

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

  test('valid signed request reaches protected release route once', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = { tradeId: 'trade-1', requestId: 'req-1' };

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-route-nonce' }),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'release-stage1',
        nonce: 'oracle-route-nonce',
        requestHash: expect.any(String),
      }),
    );
    expect(mockConsumeHmacNonce).toHaveBeenCalledWith('test-api-key', 'oracle-route-nonce', 600);
  });

  test('replayed signed request is rejected before controller runs', async () => {
    mockConsumeHmacNonce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const payload = { tradeId: 'trade-2', requestId: 'req-2' };
    const headers = createSignedHeaders(payload, { nonce: 'oracle-replay-nonce' });

    const firstResponse = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const secondResponse = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(401);
    await expect(secondResponse.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Unauthorized',
        message: 'Replay detected for nonce',
      }),
    );
  });

  test('invalid signature is rejected at the route boundary', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = { tradeId: 'trade-3', requestId: 'req-3' };

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, {
        nonce: 'oracle-invalid-signature',
        signature: '0'.repeat(64),
      }),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(401);
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Unauthorized',
        message: 'Invalid HMAC signature',
      }),
    );
  });

  test('stale timestamp is rejected at the route boundary', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = { tradeId: 'trade-4', requestId: 'req-4' };

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, {
        nonce: 'oracle-stale',
        timestamp: String(Date.now() - 6 * 60 * 1000),
      }),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(401);
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Unauthorized',
        message: expect.stringContaining('Request timestamp too old'),
      }),
    );
  });

  test('nonce persistence failure returns service unavailable', async () => {
    mockConsumeHmacNonce.mockRejectedValue(new Error('db unavailable'));
    const payload = { tradeId: 'trade-5', requestId: 'req-5' };

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-db-error' }),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'ServiceUnavailable',
        message: 'Authentication nonce store unavailable',
      }),
    );
  });
});
