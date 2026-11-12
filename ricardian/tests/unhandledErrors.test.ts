import express from 'express';
import type { Server } from 'node:http';
import { createInternalErrorHandler } from '@agroasys/shared-http';
import { Logger } from '../src/utils/logger';

describe('final HTTP failure boundary', () => {
  let server: Server;
  let url: string;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post('/failure', () => {
      throw new Error('provider refused at https://provider.invalid/fixture-secret');
    });
    app.use(
      createInternalErrorHandler({
        log: (correlationId, error) =>
          Logger.error('Unhandled request failure', { correlationId, error }),
      }),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    url = `http://127.0.0.1:${address.port}/failure`;
  });
  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorLog.mockRestore());
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test.each([
    ['{"secret":"fixture-secret" broken', 400, 'BadRequest'],
    ['{}', 500, 'InternalError'],
  ])(
    'parser and route failures return JSON with correlation and sanitized logs',
    async (body, status, code) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'unhandled-fixture' },
        body,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('x-correlation-id')).toBe('unhandled-fixture');
      const result = await response.json();
      expect(result).toMatchObject({ error: code, correlationId: 'unhandled-fixture' });
      expect(JSON.stringify(result)).not.toMatch(/fixture-secret|provider.invalid|SyntaxError/);
      expect(errorLog.mock.calls.flat().join(' ')).not.toContain('fixture-secret');
    },
  );
});
