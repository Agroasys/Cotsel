import express from 'express';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import type { Server } from 'node:http';
import {
  authMiddleware,
  createRawBodyJsonParser,
  errorHandler,
  hmacMiddleware,
} from '../src/middleware/middleware';
import { consumeHmacNonce } from '../src/database/queries';
import { generateRequestHash } from '../src/utils/crypto';
import { oracleRateLimitPolicy } from '../src/httpSecurity';

jest.mock('../src/config', () => ({
  config: { apiKey: 'test-api-key', hmacSecret: 'test-hmac-secret', hmacNonceTtlSeconds: 600 },
}));
jest.mock('../src/database/queries', () => ({ consumeHmacNonce: jest.fn() }));

describe('Oracle HMAC HTTP failure boundary', () => {
  let server: Server;
  let url: string;
  let reached: jest.Mock;
  let errorLog: jest.SpyInstance;
  let limiter: Awaited<ReturnType<typeof createHttpRateLimiter>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(consumeHmacNonce).mockReset();
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    limiter = await createHttpRateLimiter({
      enabled: true,
      keyPrefix: 'oracle',
      nodeEnv: 'test',
      classifyRoute: oracleRateLimitPolicy,
      nowSeconds: () => 1_700_000_000,
    });
    const app = express();
    reached = jest.fn();
    app.use(limiter.middleware, createRawBodyJsonParser(), authMiddleware, hmacMiddleware);
    app.post('/action', (_req, res) => {
      reached();
      res.json({ success: true });
    });
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    url = `http://127.0.0.1:${address.port}/action`;
  });

  afterEach(async () => {
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } finally {
      await limiter.close();
      errorLog.mockRestore();
    }
  });

  async function request(timestamp = Date.now().toString()) {
    const body = '{"tradeId":"42"}';
    return fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-api-key',
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': generateRequestHash(timestamp, body, 'test-hmac-secret'),
        'x-nonce': 'fixture-nonce',
        'x-correlation-id': 'hmac-failure-fixture',
      },
      body,
    });
  }

  test.each(['Request timestamp', 'Invalid HMAC signature', 'connection refused'])(
    'a nonce-store error containing %s is internal and never echoed',
    async (text) => {
      const failure = `${text}: SELECT secret FROM nonce_table at https://db.invalid/private-key`;
      jest.mocked(consumeHmacNonce).mockRejectedValueOnce(new Error(failure));
      const response = await request();
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        error: 'ServiceUnavailable',
        message: 'Authentication nonce store unavailable',
        correlationId: 'hmac-failure-fixture',
      });
      expect(response.headers.get('x-correlation-id')).toBe('hmac-failure-fixture');
      expect(JSON.stringify(body)).not.toMatch(/SELECT|nonce_table|private-key|db.invalid/);
      expect(reached).not.toHaveBeenCalled();
    },
  );

  test.each(['not-a-time', `${Date.now()}junk`, '1e20'])(
    'rejects a signed malformed timestamp %s before nonce persistence',
    async (timestamp) => {
      jest.mocked(consumeHmacNonce).mockResolvedValueOnce(true);
      const response = await request(timestamp);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ message: 'Invalid request timestamp' });
      expect(consumeHmacNonce).not.toHaveBeenCalled();
      expect(reached).not.toHaveBeenCalled();
    },
  );

  test('bounds authentication attempts before signature and nonce work', async () => {
    jest.mocked(consumeHmacNonce).mockResolvedValue(true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await request()).status).toBe(200);
    }
    expect((await request()).status).toBe(429);
    expect(consumeHmacNonce).toHaveBeenCalledTimes(20);
    expect(reached).toHaveBeenCalledTimes(20);
  });

  test.each([
    ['{"refreshToken": fixture-secret-123}', 'application/json', 400],
    [JSON.stringify({ token: 'fixture-secret-123'.repeat(10_000) }), 'application/json', 413],
    ['{}', 'application/json; charset=iso-8859-1', 415],
  ])(
    'preserves parser refusal status and log privacy (%#)',
    async (payload, contentType, status) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': contentType, 'x-correlation-id': 'oracle-parser-fixture' },
        body: payload,
      });
      const body = await response.json();
      expect(response.status).toBe(status);
      expect(body.correlationId).toBe('oracle-parser-fixture');
      expect(response.headers.get('x-correlation-id')).toBe('oracle-parser-fixture');
      expect(JSON.stringify(body)).not.toMatch(/fixture-sec|refreshToken|stack/);
      expect(errorLog).toHaveBeenCalled();
      expect(errorLog.mock.calls.flat().join(' ')).not.toMatch(/fixture-sec|refreshToken/);
      expect(consumeHmacNonce).not.toHaveBeenCalled();
      expect(reached).not.toHaveBeenCalled();
    },
  );
});
