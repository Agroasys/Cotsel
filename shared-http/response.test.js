'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { correlationIdFor, isCallerFacingError, sendInternalFailure } = require('./index');

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

test('isCallerFacingError accepts only bare domain errors', () => {
  assert.equal(isCallerFacingError(new Error('Sweep batch not found')), true);
  assert.equal(isCallerFacingError(Object.assign(new Error('x'), { code: '23505' })), false);
  assert.equal(isCallerFacingError(new TypeError('fetch failed')), false);
  class DatabaseError extends Error {}
  assert.equal(isCallerFacingError(new DatabaseError('relation missing')), false);
  assert.equal(isCallerFacingError('plain string'), false);
});
