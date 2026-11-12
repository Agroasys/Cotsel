import express from 'express';
import type { Server } from 'node:http';
import { createSessionMiddleware, errorHandler } from '../src/middleware/middleware';

describe('Auth HTTP internal failures', () => {
  let server: Server;
  let url: string;
  let resolveSession: jest.Mock;
  let reached: jest.Mock;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    const app = express();
    resolveSession = jest.fn();
    reached = jest.fn();
    app.get('/session', createSessionMiddleware(resolveSession), (_req, res) => {
      reached();
      res.json({ success: true });
    });
    app.get('/failure', () => {
      throw new Error('SQL failed at https://database.invalid/fixture-secret');
    });
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    url = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorLog.mockRestore());
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test.each([
    ['/session', 503, 'ServiceUnavailable'],
    ['/failure', 500, 'InternalServerError'],
  ])('%s returns an internal failure with correlation', async (path, status, code) => {
    resolveSession.mockRejectedValue(
      new Error('SQL failed at https://database.invalid/fixture-secret'),
    );
    const response = await fetch(`${url}${path}`, {
      headers: { authorization: 'Bearer fixture-token', 'x-correlation-id': 'auth-error-fixture' },
    });
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body).toMatchObject({ error: code, correlationId: 'auth-error-fixture' });
    expect(response.headers.get('x-correlation-id')).toBe('auth-error-fixture');
    expect(JSON.stringify(body)).not.toMatch(/SQL|database.invalid|fixture-secret|fixture-token/);
    expect(errorLog.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ correlationId: 'auth-error-fixture' }),
    );
    expect(errorLog.mock.calls.flat().join(' ')).not.toMatch(/fixture-secret|fixture-token/);
    expect(reached).not.toHaveBeenCalled();
  });

  test('a missing session remains a caller-facing 401', async () => {
    resolveSession.mockResolvedValue(null);
    const response = await fetch(`${url}/session`, {
      headers: { authorization: 'Bearer fixture-token' },
    });
    expect(response.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });
});
