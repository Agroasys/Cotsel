import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { gzipSync } from 'zlib';
import { createRouter } from '../src/api/routes';
import { generateRequestHash } from '../src/utils/crypto';
import { consumeHmacNonce } from '../src/database/queries';
import { createRawBodyJsonParser, errorHandler } from '../src/middleware/middleware';

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
    signedBody?: string;
  },
) {
  const timestamp = overrides?.timestamp ?? Date.now().toString();
  const authorization = overrides?.authorization ?? 'Bearer test-api-key';
  const bodyText = overrides?.signedBody ?? JSON.stringify(body);
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
    releaseStage1: jest.fn(async (req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        route: 'release-stage1',
        requestHash: req.hmacSignature,
        nonce: req.hmacNonce,
      });
    }),
    confirmArrival: jest.fn(async (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    }),
    finalizeTrade: jest.fn(async (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    }),
    redriveTrigger: jest.fn(async (req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'redrive', nonce: req.hmacNonce });
    }),
    approveTrigger: jest.fn(async (req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'approve', nonce: req.hmacNonce });
    }),
    rejectTrigger: jest.fn(async (req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'reject', nonce: req.hmacNonce });
    }),
    listTriggers: jest.fn(async (req: Request, res: Response) => {
      res.status(200).json({ success: true, status: req.query.status ?? null });
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const app = express();
    app.use(createRawBodyJsonParser());
    app.use('/api/oracle', createRouter(controller as never));
    app.use(errorHandler);

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
    expect(controller.releaseStage1).toHaveBeenCalledTimes(1);
    await expect(secondResponse.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Unauthorized',
        message: 'Replay detected for nonce',
      }),
    );
  });

  test('reused nonce with freshly generated signed headers is rejected', async () => {
    mockConsumeHmacNonce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const payload = { tradeId: 'trade-2b', requestId: 'req-2b' };
    const nonce = 'oracle-replay-nonce-fresh-timestamp';
    const firstTimestamp = Date.now().toString();
    const secondTimestamp = (Date.now() + 1_000).toString();

    const firstResponse = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce, timestamp: firstTimestamp }),
      body: JSON.stringify(payload),
    });

    const secondResponse = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce, timestamp: secondTimestamp }),
      body: JSON.stringify(payload),
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(401);
    expect(controller.releaseStage1).toHaveBeenCalledTimes(1);
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

  test('valid signed GET reaches protected trigger queue route', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);

    const response = await fetch(`${baseUrl}/api/oracle/triggers?status=pending_approval`, {
      headers: createSignedHeaders({}, { nonce: 'oracle-trigger-list' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        status: 'pending_approval',
      }),
    );
    expect(mockConsumeHmacNonce).toHaveBeenCalledWith('test-api-key', 'oracle-trigger-list', 600);
  });

  test('signed GET over the empty body reaches protected trigger queue route', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);

    const response = await fetch(`${baseUrl}/api/oracle/triggers`, {
      headers: createSignedHeaders({}, { nonce: 'oracle-trigger-list-empty', signedBody: '' }),
    });

    expect(response.status).toBe(200);
    expect(controller.listTriggers).toHaveBeenCalledTimes(1);
  });

  test('re-serialized JSON with reordered keys is rejected at the route boundary', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = { tradeId: 'trade-order', requestId: 'req-order' };

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-key-order' }),
      body: JSON.stringify({ requestId: payload.requestId, tradeId: payload.tradeId }),
    });

    expect(response.status).toBe(401);
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    expect(controller.releaseStage1).not.toHaveBeenCalled();
  });

  test('whitespace-only body changes are rejected at the route boundary', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = { tradeId: 'trade-space', requestId: 'req-space' };

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-whitespace' }),
      body: JSON.stringify(payload, null, 2),
    });

    expect(response.status).toBe(401);
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    expect(controller.releaseStage1).not.toHaveBeenCalled();
  });

  test('non-JSON body signed over the legacy {} placeholder is rejected', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: {
        ...createSignedHeaders({}, { nonce: 'oracle-legacy-text-body', signedBody: '{}' }),
        'content-type': 'text/plain',
      },
      body: 'not-the-signed-body',
    });

    expect(response.status).toBe(401);
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    expect(controller.releaseStage1).not.toHaveBeenCalled();
  });

  test('non-JSON body signed over its own bytes is rejected', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const body = 'tradeId=trade-text';

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: {
        ...createSignedHeaders({}, { nonce: 'oracle-text-body', signedBody: body }),
        'content-type': 'text/plain',
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    expect(controller.releaseStage1).not.toHaveBeenCalled();
  });

  test('gzip-encoded body signed over the uncompressed JSON is rejected', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = { tradeId: 'trade-gzip', requestId: 'req-gzip' };

    const response = await fetch(`${baseUrl}/api/oracle/release-stage1`, {
      method: 'POST',
      headers: {
        ...createSignedHeaders(payload, { nonce: 'oracle-gzip' }),
        'content-encoding': 'gzip',
      },
      body: gzipSync(JSON.stringify(payload)),
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'UnsupportedMediaType' }),
    );
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    expect(controller.releaseStage1).not.toHaveBeenCalled();
  });

  test('valid signed redrive request reaches redrive route once', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = {
      tradeId: 'trade-redrive',
      requestId: 'req-redrive',
      triggerType: 'release_stage_1',
    };

    const response = await fetch(`${baseUrl}/api/oracle/redrive`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-redrive-route' }),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'redrive',
        nonce: 'oracle-redrive-route',
      }),
    );
    expect(controller.redriveTrigger).toHaveBeenCalledTimes(1);
  });

  test('valid signed approve request reaches approval route once', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = {
      idempotencyKey: 'RELEASE_STAGE_1:trade-approval:req-approval',
      actor: 'operator@agroasys',
    };

    const response = await fetch(`${baseUrl}/api/oracle/approve`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-approve-route' }),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'approve',
        nonce: 'oracle-approve-route',
      }),
    );
    expect(controller.approveTrigger).toHaveBeenCalledTimes(1);
  });

  test('valid signed reject request reaches rejection route once with audit reason payload', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const payload = {
      idempotencyKey: 'RELEASE_STAGE_1:trade-reject:req-reject',
      actor: 'operator@agroasys',
      reason: 'Oracle evidence did not match the reviewed trade state.',
    };

    const response = await fetch(`${baseUrl}/api/oracle/reject`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-reject-route' }),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'reject',
        nonce: 'oracle-reject-route',
      }),
    );
    expect(controller.rejectTrigger).toHaveBeenCalledTimes(1);
  });

  test('replayed approval request is rejected before approval controller runs', async () => {
    mockConsumeHmacNonce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const payload = {
      idempotencyKey: 'RELEASE_STAGE_1:trade-replay:req-replay',
      actor: 'operator@agroasys',
    };

    const firstResponse = await fetch(`${baseUrl}/api/oracle/approve`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-approval-replay' }),
      body: JSON.stringify(payload),
    });
    const secondResponse = await fetch(`${baseUrl}/api/oracle/approve`, {
      method: 'POST',
      headers: createSignedHeaders(payload, { nonce: 'oracle-approval-replay' }),
      body: JSON.stringify(payload),
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(401);
    expect(controller.approveTrigger).toHaveBeenCalledTimes(1);
  });
});
