import { NextFunction, Request, Response } from 'express';
import { createRicardianRateLimiter } from '../src/rateLimit/limiter';

interface MockResponse extends Response {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
}

function createMockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  response.setHeader = jest.fn();
  return response;
}

function createRequest(
  path: string,
  method: string = 'POST',
  apiKey?: string,
  ip: string = '127.0.0.1',
  authenticatedApiKeyId?: string,
): Request {
  return {
    method,
    path,
    header(name: string) {
      if (name.toLowerCase() === 'x-api-key') {
        return apiKey;
      }
      return undefined;
    },
    ip,
    socket: {
      remoteAddress: ip,
    },
    serviceAuth: authenticatedApiKeyId
      ? {
          apiKeyId: authenticatedApiKeyId,
          scheme: 'api_key',
        }
      : undefined,
  } as unknown as Request;
}

describe('ricardian rate limiter', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('under limit succeeds', async () => {
    const now = 1700000000;

    const limiter = await createRicardianRateLimiter({
      config: {
        enabled: true,
        nodeEnv: 'development',
        writeRoute: {
          burst: { limit: 2, windowSeconds: 10 },
          sustained: { limit: 10, windowSeconds: 60 },
        },
        readRoute: {
          burst: { limit: 4, windowSeconds: 10 },
          sustained: { limit: 30, windowSeconds: 60 },
        },
      },
      logger,
      nowSeconds: () => now,
    });

    const req = createRequest('/hash', 'POST', 'svc-a');
    const res = createMockResponse();
    const next = jest.fn() as NextFunction;

    await limiter.middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Limit', '10');
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '9');

    await limiter.close();
  });

  test('above limit returns 429', async () => {
    const now = 1700000000;

    const limiter = await createRicardianRateLimiter({
      config: {
        enabled: true,
        nodeEnv: 'development',
        writeRoute: {
          burst: { limit: 1, windowSeconds: 10 },
          sustained: { limit: 10, windowSeconds: 60 },
        },
        readRoute: {
          burst: { limit: 4, windowSeconds: 10 },
          sustained: { limit: 30, windowSeconds: 60 },
        },
      },
      logger,
      nowSeconds: () => now,
    });

    const req = createRequest('/hash', 'POST', 'svc-a');
    const first = createMockResponse();
    const second = createMockResponse();

    await limiter.middleware(req, first, jest.fn() as NextFunction);
    await limiter.middleware(req, second, jest.fn() as NextFunction);

    expect(second.status).toHaveBeenCalledWith(429);
    expect(second.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Rate limit exceeded. Retry after the provided delay.',
      }),
    );
    expect(second.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));

    await limiter.close();
  });

  test('window reset allows recovery', async () => {
    let now = 1700000000;

    const limiter = await createRicardianRateLimiter({
      config: {
        enabled: true,
        nodeEnv: 'development',
        writeRoute: {
          burst: { limit: 1, windowSeconds: 5 },
          sustained: { limit: 10, windowSeconds: 60 },
        },
        readRoute: {
          burst: { limit: 4, windowSeconds: 10 },
          sustained: { limit: 30, windowSeconds: 60 },
        },
      },
      logger,
      nowSeconds: () => now,
    });

    const req = createRequest('/hash', 'POST', 'svc-a');

    await limiter.middleware(req, createMockResponse(), jest.fn() as NextFunction);

    const blockedResponse = createMockResponse();
    await limiter.middleware(req, blockedResponse, jest.fn() as NextFunction);
    expect(blockedResponse.status).toHaveBeenCalledWith(429);

    now = now + 6;

    const recoveredResponse = createMockResponse();
    const recoveredNext = jest.fn() as NextFunction;
    await limiter.middleware(req, recoveredResponse, recoveredNext);

    expect(recoveredNext).toHaveBeenCalledTimes(1);
    expect(recoveredResponse.status).not.toHaveBeenCalled();

    await limiter.close();
  });

  test('write limiter applies to trailing slash hash route', async () => {
    const limiter = await createRicardianRateLimiter({
      config: {
        enabled: true,
        nodeEnv: 'development',
        writeRoute: {
          burst: { limit: 1, windowSeconds: 10 },
          sustained: { limit: 10, windowSeconds: 60 },
        },
        readRoute: {
          burst: { limit: 4, windowSeconds: 10 },
          sustained: { limit: 30, windowSeconds: 60 },
        },
      },
      logger,
      nowSeconds: () => 1700000000,
    });

    const req = createRequest('/hash/', 'POST', 'svc-a');

    await limiter.middleware(req, createMockResponse(), jest.fn() as NextFunction);

    const blockedResponse = createMockResponse();
    await limiter.middleware(req, blockedResponse, jest.fn() as NextFunction);

    expect(blockedResponse.status).toHaveBeenCalledWith(429);

    await limiter.close();
  });

  test('write limiter identity does not trust unauthenticated X-Api-Key rotation', async () => {
    const limiter = await createRicardianRateLimiter({
      config: {
        enabled: true,
        nodeEnv: 'development',
        writeRoute: {
          burst: { limit: 1, windowSeconds: 10 },
          sustained: { limit: 10, windowSeconds: 60 },
        },
        readRoute: {
          burst: { limit: 4, windowSeconds: 10 },
          sustained: { limit: 30, windowSeconds: 60 },
        },
      },
      logger,
      nowSeconds: () => 1700000000,
    });

    const firstReq = createRequest('/hash', 'POST', 'svc-a', '127.0.0.1');
    const secondReq = createRequest('/hash', 'POST', 'svc-b', '127.0.0.1');

    await limiter.middleware(firstReq, createMockResponse(), jest.fn() as NextFunction);

    const blockedResponse = createMockResponse();
    await limiter.middleware(secondReq, blockedResponse, jest.fn() as NextFunction);

    expect(blockedResponse.status).toHaveBeenCalledWith(429);

    await limiter.close();
  });

  test('write limiter namespaces authenticated requests by api key and ip', async () => {
    const limiter = await createRicardianRateLimiter({
      config: {
        enabled: true,
        nodeEnv: 'development',
        writeRoute: {
          burst: { limit: 1, windowSeconds: 10 },
          sustained: { limit: 10, windowSeconds: 60 },
        },
        readRoute: {
          burst: { limit: 4, windowSeconds: 10 },
          sustained: { limit: 30, windowSeconds: 60 },
        },
      },
      logger,
      nowSeconds: () => 1700000000,
    });

    const firstReq = createRequest('/hash', 'POST', 'svc-a', '127.0.0.1', 'svc-a');
    const secondReq = createRequest('/hash', 'POST', 'svc-b', '127.0.0.1', 'svc-b');

    const firstNext = jest.fn() as NextFunction;
    const secondNext = jest.fn() as NextFunction;

    await limiter.middleware(firstReq, createMockResponse(), firstNext);
    await limiter.middleware(secondReq, createMockResponse(), secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).toHaveBeenCalledTimes(1);

    await limiter.close();
  });
});
