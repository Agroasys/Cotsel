'use strict';

const { createHttpRateLimiter } = require('./rateLimit');

function createMockResponse() {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  response.setHeader = jest.fn();
  return response;
}

function createRequest(path, method = 'GET', overrides = {}) {
  return {
    method,
    path,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

describe('shared edge rate limiter', () => {
  test('allows requests under the limit and emits headers', async () => {
    const limiter = await createHttpRateLimiter({
      enabled: true,
      nodeEnv: 'development',
      keyPrefix: 'test',
      classifyRoute: () => ({
        name: 'read',
        burst: { limit: 2, windowSeconds: 10 },
        sustained: { limit: 10, windowSeconds: 60 },
      }),
      nowSeconds: () => 1700000000,
    });

    const res = createMockResponse();
    const next = jest.fn();

    await limiter.middleware(createRequest('/health'), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Limit', '10');
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '9');

    await limiter.close();
  });

  test('returns 429 when a window is exceeded', async () => {
    const limiter = await createHttpRateLimiter({
      enabled: true,
      nodeEnv: 'development',
      keyPrefix: 'test',
      classifyRoute: () => ({
        name: 'write',
        burst: { limit: 1, windowSeconds: 10 },
        sustained: { limit: 10, windowSeconds: 60 },
      }),
      nowSeconds: () => 1700000000,
    });

    await limiter.middleware(createRequest('/mutation', 'POST'), createMockResponse(), jest.fn());

    const blocked = createMockResponse();
    await limiter.middleware(createRequest('/mutation', 'POST'), blocked, jest.fn());

    expect(blocked.status).toHaveBeenCalledWith(429);
    expect(blocked.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Rate limit exceeded. Retry after the provided delay.',
      }),
    );

    await limiter.close();
  });

  test('returns 503 when the backing store fails', async () => {
    const limiter = await createHttpRateLimiter({
      enabled: true,
      nodeEnv: 'development',
      keyPrefix: 'test',
      classifyRoute: () => ({
        name: 'write',
        burst: { limit: 1, windowSeconds: 10 },
        sustained: { limit: 10, windowSeconds: 60 },
      }),
      store: {
        async incrementAndGet() {
          throw new Error('boom');
        },
        async close() {},
      },
      nowSeconds: () => 1700000000,
    });

    const res = createMockResponse();
    const next = jest.fn();
    await limiter.middleware(createRequest('/mutation', 'POST'), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Rate limiting unavailable',
    });

    await limiter.close();
  });
});
