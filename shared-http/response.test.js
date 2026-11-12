'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CallerSafeError,
  HttpError,
  correlationIdFor,
  isCallerSafeError,
  sendInternalFailure,
  createInternalErrorHandler,
} = require('./index');

function recordingResponse() {
  const recorded = { headers: {} };
  return {
    recorded,
    setHeader(name, value) {
      recorded.headers[name] = value;
    },
    status(code) {
      recorded.status = code;
      return {
        json(body) {
          recorded.body = body;
        },
      };
    },
  };
}

test('the final boundary preserves explicitly caller-safe refusals without internal-error logging', () => {
  for (const [error, status, code, message, details] of [
    [
      new HttpError(409, 'Conflict', 'Already submitted', { state: 'pending' }),
      409,
      'Conflict',
      'Already submitted',
      { state: 'pending' },
    ],
    [
      new CallerSafeError('limit is invalid'),
      400,
      'ValidationError',
      'limit is invalid',
      undefined,
    ],
  ]) {
    const res = recordingResponse();
    createInternalErrorHandler({
      log: () => assert.fail('caller refusal is not an internal fault'),
    })(error, { headers: {} }, res, () => assert.fail('must handle caller refusal'));
    assert.equal(res.recorded.status, status);
    assert.equal(res.recorded.body.error, code);
    assert.equal(res.recorded.body.message, message);
    assert.deepEqual(res.recorded.body.details, details);
  }
});

test('the final error boundary delegates an already-started response without writing', () => {
  const res = recordingResponse();
  res.headersSent = true;
  const error = new Error('stream failed');
  const forwarded = [];
  createInternalErrorHandler({ log: () => assert.fail('must not write another response') })(
    error,
    { headers: {} },
    res,
    (cause) => forwarded.push(cause),
  );
  assert.deepEqual(forwarded, [error]);
  assert.deepEqual(res.recorded, { headers: {} });
});

test('body-parser refusals preserve client status without logging submitted body text', () => {
  for (const [type, status] of [
    ['entity.parse.failed', 400],
    ['entity.too.large', 413],
    ['encoding.unsupported', 415],
    ['charset.unsupported', 415],
    ['entity.verify.failed', 403],
    ['request.aborted', 400],
    ['request.size.invalid', 400],
  ]) {
    const res = recordingResponse();
    const logged = [];
    const error = Object.assign(new Error('submitted-body-fixture-secret'), { type });
    createInternalErrorHandler({ log: (_id, cause) => logged.push(cause) })(
      error,
      { headers: {} },
      res,
      () => assert.fail('must handle the client failure'),
    );
    assert.equal(res.recorded.status, status, type);
    assert.equal(JSON.stringify(res.recorded.body).includes('fixture-secret'), false);
    assert.equal(logged[0].message.includes('fixture-secret'), false);
    assert.equal(logged[0].stack.includes('fixture-secret'), false);
  }
});

test('correlationIdFor reuses a well-formed inbound header', () => {
  assert.equal(
    correlationIdFor({ headers: { 'x-request-id': 'req-0123456789' } }),
    'req-0123456789',
  );
  assert.equal(
    correlationIdFor({
      headers: { 'x-correlation-id': 'corr-0123456789', 'x-request-id': 'req-0123456789' },
    }),
    'corr-0123456789',
  );
});

test('correlationIdFor never echoes malformed caller text', () => {
  for (const value of ['short', '<script>alert(1)</script>', 'a'.repeat(129), ['array-value']]) {
    const id = correlationIdFor({ headers: { 'x-request-id': value } });
    assert.notEqual(id, value);
    assert.match(id, /^[0-9a-f-]{36}$/);
  }
  assert.match(correlationIdFor(undefined), /^[0-9a-f-]{36}$/);
});

test('sendInternalFailure logs the raw error and returns only a stable code', () => {
  const res = recordingResponse();
  const logged = [];
  const raw = new Error(
    'connect ECONNREFUSED postgres://svc:secret@10.0.0.4:5432/db; SELECT * FROM ledger',
  );

  const id = sendInternalFailure({ headers: {} }, res, raw, {
    log: (correlationId, error) => logged.push({ correlationId, error }),
  });

  assert.deepEqual(logged, [{ correlationId: id, error: raw }]);
  assert.equal(res.recorded.status, 500);
  assert.equal(res.recorded.headers['x-correlation-id'], id);
  assert.equal(res.recorded.body.error, 'InternalError');
  assert.equal(res.recorded.body.message, 'An unexpected error occurred');
  assert.equal(res.recorded.body.correlationId, id);
  const serialized = JSON.stringify(res.recorded.body);
  for (const leaked of ['ECONNREFUSED', 'secret', 'SELECT', '10.0.0.4', 'stack']) {
    assert.equal(serialized.includes(leaked), false, leaked);
  }
});

test('sendInternalFailure accepts a fixed code, message, and status', () => {
  const res = recordingResponse();
  sendInternalFailure({ headers: {} }, res, new Error('rpc https://node.example/key'), {
    log: () => {},
    statusCode: 503,
    code: 'UpstreamUnavailable',
    message: 'Chain data is unavailable',
  });
  assert.equal(res.recorded.status, 503);
  assert.equal(res.recorded.body.error, 'UpstreamUnavailable');
  assert.equal(res.recorded.body.message, 'Chain data is unavailable');
});

test('isCallerSafeError accepts only explicitly caller-safe errors', () => {
  assert.equal(isCallerSafeError(new CallerSafeError('Sweep batch not found')), true);
  assert.equal(isCallerSafeError(new HttpError(400, 'BadRequest', 'limit is invalid')), true);
  // A plain Error is never trusted, whatever it says: pg and GraphQL clients emit these.
  assert.equal(isCallerSafeError(new Error('Connection terminated unexpectedly')), false);
  assert.equal(
    isCallerSafeError(new Error('Indexer GraphQL errors: relation "x" at https://h')),
    false,
  );
  assert.equal(isCallerSafeError(Object.assign(new Error('x'), { code: '23505' })), false);
  assert.equal(isCallerSafeError(new TypeError('fetch failed')), false);
  assert.equal(isCallerSafeError('plain string'), false);
});
