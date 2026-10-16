/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-10 I-06: injected database, network, RPC and timeout failures reach the
 * caller only as a stable code and a correlation ID. Domain refusals written
 * for the caller keep their message.
 */
import type { Request, Response } from 'express';
import { CallerSafeError, HttpError } from '@agroasys/shared-http';
import { mapValidationError, sendMappedError } from '../src/api/errorMapping';
import { NonCanonicalAmountError } from '../src/core/canonicalAmount';
import { TreasuryConcurrentTransitionError } from '../src/core/transitionConcurrency';
import { FetchTimeoutError, IndexerNetworkError } from '../src/utils/fetchWithTimeout';

const SECRET_URL = 'https://rpc.example/v2/sk_live_abc123';

class FakeDatabaseError extends Error {
  readonly code = '42P01';
  readonly severity = 'ERROR';
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const INTERNAL_FAILURES: Array<[string, unknown]> = [
  // Plain errors are never trusted: pg and the GraphQL client both raise them.
  ['uncoded database', new Error('Connection terminated unexpectedly to 10.0.4.12')],
  [
    'GraphQL',
    new Error(
      `Indexer GraphQL errors: relation "treasury_ledger_entries" missing at ${SECRET_URL}`,
    ),
  ],
  ['SQL', new FakeDatabaseError('relation "treasury_ledger_entries" does not exist')],
  ['network', withCode('connect ECONNREFUSED 10.0.4.12:5432', 'ECONNREFUSED')],
  ['RPC', withCode(`missing response (requestBody="{}", url="${SECRET_URL}")`, 'SERVER_ERROR')],
  ['fetch', new TypeError(`fetch failed for ${SECRET_URL}`)],
  ['timeout', new FetchTimeoutError(`${SECRET_URL}/graphql`, 5000)],
  ['indexer', new IndexerNetworkError(`${SECRET_URL}/graphql`, 'socket hang up')],
  ['non-error', `provider said: ${SECRET_URL}`],
];

type RecordedResponse = Response & {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
};

function recordedResponse(): RecordedResponse {
  const res = {} as RecordedResponse;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  return res;
}

describe('treasury error mapping', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  test.each(INTERNAL_FAILURES)(
    'a %s failure returns only a stable code and correlation ID',
    (_label, failure) => {
      const req = { headers: { 'x-request-id': 'gateway-req-000001' } } as unknown as Request;
      const res = recordedResponse();

      sendMappedError(req, res, failure, 'Failed to persist treasury evidence');

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body).toMatchObject({
        success: false,
        error: 'InternalError',
        message: 'An unexpected error occurred',
        correlationId: 'gateway-req-000001',
      });
      expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'gateway-req-000001');
      const serialized = JSON.stringify(body);
      for (const leaked of [
        'sk_live',
        'rpc.example',
        '10.0.4.12',
        'treasury_ledger_entries',
        'ECONNREFUSED',
        'socket hang up',
        'at ',
      ]) {
        expect(serialized).not.toContain(leaked);
      }

      // The full cause is kept for the operator under the same correlation ID.
      const logged = JSON.parse(errorLog.mock.calls[0][0] as string);
      expect(logged).toMatchObject({
        correlationId: 'gateway-req-000001',
        operation: 'Failed to persist treasury evidence',
      });
    },
  );

  test('domain refusals keep their caller-facing message', () => {
    expect(mapValidationError(new CallerSafeError('Sweep batch not found'), 'fallback')).toEqual({
      statusCode: 400,
      body: expect.objectContaining({
        error: 'ValidationError',
        message: 'Sweep batch not found',
      }),
    });
    expect(
      mapValidationError(new NonCanonicalAmountError('amountRaw', 'leading zero'), 'fallback'),
    ).toMatchObject({ statusCode: 400, body: { error: 'ValidationError' } });
    expect(
      mapValidationError(new HttpError(422, 'Unprocessable', 'Bad shape'), 'fallback'),
    ).toMatchObject({ statusCode: 422, body: { error: 'Unprocessable', message: 'Bad shape' } });
  });

  test('the losing writer of a maker-checker race gets a stable conflict', () => {
    expect(
      mapValidationError(
        new TreasuryConcurrentTransitionError('Sweep batch changed state while approving'),
        'fallback',
      ),
    ).toMatchObject({ statusCode: 409, body: { error: 'ConcurrentTransition' } });
  });

  test('internal failures are not mapped as caller errors', () => {
    for (const [, failure] of INTERNAL_FAILURES) {
      expect(mapValidationError(failure, 'fallback')).toBeNull();
    }
  });
});
