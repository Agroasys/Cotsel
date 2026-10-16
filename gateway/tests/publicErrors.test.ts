/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-10 I-06: upstream, RPC and database failure text stays in the logs. The
 * response carries a stable code, the request and trace IDs, and only
 * non-sensitive details.
 */
import type { NextFunction, Request, Response } from 'express';
import { GatewayError, diagnosticReason } from '../src/errors';
import { errorHandler } from '../src/middleware/errorHandler';

const RPC_SECRET = 'https://base-sepolia.example/v2/alchemy-key-0123';
const LEAKS = ['alchemy-key', 'base-sepolia.example', 'ECONNREFUSED', 'governance_actions'];

function recordedResponse() {
  const res = { locals: {} } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function request(): Request {
  return {
    method: 'GET',
    path: '/governance/status',
    originalUrl: '/api/dashboard-gateway/v1/governance/status',
    requestContext: { requestId: 'req-123', correlationId: 'trace-123' },
  } as unknown as Request;
}

describe('gateway public errors', () => {
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnLog = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  test('upstream failure diagnostics are logged but never returned', async () => {
    const cause = new Error(`missing response (requestBody="{}", url="${RPC_SECRET}")`);
    const res = recordedResponse();

    await errorHandler(
      new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Failed to read governance status from chain',
        { upstream: 'chain-rpc' },
        { cause: diagnosticReason(cause) },
      ),
      request(),
      res,
      jest.fn() as unknown as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Failed to read governance status from chain',
      requestId: 'req-123',
      traceId: 'trace-123',
      details: { upstream: 'chain-rpc' },
    });
    const serialized = JSON.stringify(body);
    for (const leaked of LEAKS) {
      expect(serialized).not.toContain(leaked);
    }

    const logged = JSON.parse(warnLog.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      correlationId: 'trace-123',
      diagnostics: { cause: cause.message },
    });
  });

  test('an unexpected database failure returns only INTERNAL_ERROR and the trace ID', async () => {
    const res = recordedResponse();

    await errorHandler(
      Object.assign(new Error('relation "governance_actions" does not exist'), {
        code: '42P01',
      }),
      request(),
      res,
      jest.fn() as unknown as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      traceId: 'trace-123',
    });
    expect(body.error.details).toBeUndefined();
    const serialized = JSON.stringify(body);
    for (const leaked of LEAKS) {
      expect(serialized).not.toContain(leaked);
    }
  });
});
