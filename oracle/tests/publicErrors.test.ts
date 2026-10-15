/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-10 I-06: injected RPC, signer and database failures reach the caller only
 * as a stable code and a correlation ID; the raw text is kept in the logs.
 */
import type { NextFunction, Request, Response } from 'express';
import { OracleController } from '../src/api/controller';
import { errorHandler } from '../src/middleware/middleware';
import { ErrorType } from '../src/types/trigger';
import type { ErrorResponse, OracleResponse } from '../src/types';
import { publicFailureMessage } from '../src/utils/errors';

jest.mock('../src/config', () => ({ config: {} }));
jest.mock('../src/database/queries', () => ({ listTriggers: jest.fn() }));

const RPC_SECRET = 'https://base-sepolia.example/v2/alchemy-key-0123';
const LEAKS = ['alchemy-key', 'base-sepolia.example', '10.1.2.3', 'oracle_triggers', 'at '];

function responseRecorder() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  return { status, json, setHeader };
}

function expectNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body);
  for (const leaked of LEAKS) {
    expect(serialized).not.toContain(leaked);
  }
}

describe('Oracle public errors', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  it.each([
    ['RPC', new Error(`missing response (requestBody="{}", url="${RPC_SECRET}")`)],
    ['signer', Object.assign(new Error('KMS signer at 10.1.2.3 refused'), { code: 'EACCES' })],
    ['SQL', new Error('relation "oracle_triggers" does not exist')],
  ])('a thrown %s failure returns a stable code and correlation ID', async (_label, failure) => {
    const triggerManager = { executeTrigger: jest.fn().mockRejectedValue(failure) };
    const controller = new OracleController(triggerManager as never);
    const recorder = responseRecorder();

    await controller.finalizeTrade(
      {
        body: { tradeId: '42', requestId: 'request-42' },
        headers: { 'x-request-id': 'gateway-request-42' },
        path: '/finalize-trade',
      } as unknown as Request,
      recorder as unknown as Response<OracleResponse | ErrorResponse>,
    );

    expect(recorder.status).toHaveBeenCalledWith(500);
    const body = recorder.json.mock.calls[0][0];
    expect(body).toMatchObject({
      success: false,
      error: 'InternalError',
      message: 'An unexpected error occurred',
      correlationId: 'gateway-request-42',
    });
    expectNoLeak(body);
    const logged = errorLog.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(logged).toContainEqual(
      expect.objectContaining({
        message: 'Oracle request failed',
        correlationId: 'gateway-request-42',
      }),
    );
  });

  it('the unhandled-error middleware never returns the raw error', () => {
    const recorder = responseRecorder();
    errorHandler(
      new Error(`provider exploded at ${RPC_SECRET}`),
      { headers: {}, path: '/x' } as unknown as Request,
      recorder as unknown as Response<ErrorResponse>,
      jest.fn() as unknown as NextFunction,
    );

    expect(recorder.status).toHaveBeenCalledWith(500);
    const body = recorder.json.mock.calls[0][0];
    expect(body).toMatchObject({
      error: 'InternalServerError',
      correlationId: expect.any(String),
    });
    expectNoLeak(body);
  });

  it('trigger results keep domain refusals but not network or contract detail', () => {
    expect(publicFailureMessage(ErrorType.VALIDATION, 'Cannot release stage 1 for trade 42')).toBe(
      'Cannot release stage 1 for trade 42',
    );
    for (const errorType of [ErrorType.NETWORK, ErrorType.CONTRACT, null]) {
      const message = publicFailureMessage(errorType, `could not reach ${RPC_SECRET}`);
      expect(message).toMatch(/^Oracle \w+ failure; detail is recorded on the trigger$/);
      expectNoLeak(message);
    }
  });
});
