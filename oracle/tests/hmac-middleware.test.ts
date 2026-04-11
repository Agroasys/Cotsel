import { NextFunction, Request, Response } from 'express';
import { authMiddleware, hmacMiddleware } from '../src/middleware/middleware';
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

interface MockResponse extends Response {
  status: jest.Mock;
  json: jest.Mock;
}

type MockRequest = Partial<Request> & {
  headers: Record<string, string>;
  body: Record<string, unknown>;
  ip: string;
  apiKeyToken?: string;
  hmacSignature?: string;
  hmacNonce?: string;
};

function createMockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

function createSignedRequest(overrides?: {
  body?: Record<string, unknown>;
  timestamp?: string;
  signature?: string;
  nonce?: string;
  authorization?: string;
}): MockRequest {
  const body = overrides?.body ?? { tradeId: '1', requestId: 'req-1' };
  const timestamp = overrides?.timestamp ?? Date.now().toString();
  const authHeader = overrides?.authorization ?? 'Bearer test-api-key';
  const bodyText = JSON.stringify(body);
  const signature =
    overrides?.signature ?? generateRequestHash(timestamp, bodyText, 'test-hmac-secret');

  const headers: Record<string, string> = {
    authorization: authHeader,
    'x-timestamp': timestamp,
    'x-signature': signature,
  };

  if (overrides?.nonce !== undefined) {
    headers['x-nonce'] = overrides.nonce;
  }

  return {
    headers,
    body,
    ip: '127.0.0.1',
  };
}

describe('oracle hmac middleware', () => {
  const mockConsumeHmacNonce = consumeHmacNonce as jest.MockedFunction<typeof consumeHmacNonce>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('request with nonce succeeds', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);

    const req = createSignedRequest({ nonce: 'nonce-1' });
    const res = createMockResponse();
    const authNext = jest.fn() as NextFunction;
    const hmacNext = jest.fn() as NextFunction;

    authMiddleware(req as Request, res, authNext);
    expect(authNext).toHaveBeenCalledTimes(1);

    await hmacMiddleware(req as Request, res, hmacNext);

    expect(hmacNext).toHaveBeenCalledTimes(1);
    expect(mockConsumeHmacNonce).toHaveBeenCalledWith('test-api-key', 'nonce-1', 600);
    expect(req.hmacSignature).toBeDefined();
    expect(req.hmacNonce).toBe('nonce-1');
  });

  test('same request replay fails', async () => {
    mockConsumeHmacNonce.mockResolvedValue(false);

    const req = createSignedRequest({ nonce: 'nonce-replay' });
    const res = createMockResponse();
    const authNext = jest.fn() as NextFunction;
    const hmacNext = jest.fn() as NextFunction;

    authMiddleware(req as Request, res, authNext);
    expect(authNext).toHaveBeenCalledTimes(1);

    await hmacMiddleware(req as Request, res, hmacNext);

    expect(hmacNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Replay detected for nonce' }),
    );
  });

  test('old timestamp fails', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);
    const staleTimestamp = (Date.now() - 6 * 60 * 1000).toString();

    const req = createSignedRequest({ timestamp: staleTimestamp, nonce: 'nonce-old' });
    const res = createMockResponse();
    const authNext = jest.fn() as NextFunction;
    const hmacNext = jest.fn() as NextFunction;

    authMiddleware(req as Request, res, authNext);
    expect(authNext).toHaveBeenCalledTimes(1);

    await hmacMiddleware(req as Request, res, hmacNext);

    expect(hmacNext).not.toHaveBeenCalled();
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Request timestamp too old') }),
    );
  });

  test('invalid signature fails', async () => {
    mockConsumeHmacNonce.mockResolvedValue(true);

    const req = createSignedRequest({
      nonce: 'nonce-bad-signature',
      signature: '0'.repeat(64),
    });
    const res = createMockResponse();
    const authNext = jest.fn() as NextFunction;
    const hmacNext = jest.fn() as NextFunction;

    authMiddleware(req as Request, res, authNext);
    expect(authNext).toHaveBeenCalledTimes(1);

    await hmacMiddleware(req as Request, res, hmacNext);

    expect(hmacNext).not.toHaveBeenCalled();
    expect(mockConsumeHmacNonce).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Invalid HMAC signature' }),
    );
  });
});
