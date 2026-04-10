'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  parseServiceApiKeys,
  signServiceAuthCanonicalString,
} = require('./serviceAuth');

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function createRequest(overrides = {}) {
  const headers = new Map();
  for (const [key, value] of Object.entries(overrides.headers ?? {})) {
    headers.set(key.toLowerCase(), value);
  }

  return {
    method: overrides.method ?? 'POST',
    originalUrl: overrides.originalUrl ?? '/internal/settlement?mode=test',
    rawBody: overrides.rawBody ?? Buffer.from('{"ok":true}'),
    header(name) {
      return headers.get(String(name).toLowerCase());
    },
    ...overrides,
  };
}

test('parseServiceApiKeys validates active and trims values', () => {
  const keys = parseServiceApiKeys('[{"id":" gateway ","secret":" top-secret ","active":true}]');
  assert.deepEqual(keys, [{ id: 'gateway', secret: 'top-secret', active: true }]);
  assert.throws(() => parseServiceApiKeys('[{"id":"a","secret":"b","active":"yes"}]'), /active must be a boolean/);
});

test('service auth middleware accepts a valid signed request', async () => {
  const apiKey = 'gateway';
  const secret = 'top-secret';
  const timestamp = '1700000000';
  const nonce = 'nonce-1';
  const canonical = buildServiceAuthCanonicalString({
    method: 'POST',
    path: '/internal/settlement',
    query: 'mode=test',
    bodySha256: '4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93',
    timestamp,
    nonce,
  });
  const signature = signServiceAuthCanonicalString(secret, canonical);
  const consumeCalls = [];

  const middleware = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: 30,
    nonceTtlSeconds: 60,
    nowSeconds: () => Number(timestamp),
    lookupApiKey: (candidate) => (candidate === apiKey ? { id: apiKey, secret, active: true } : undefined),
    consumeNonce: async (...args) => {
      consumeCalls.push(args);
      return true;
    },
  });

  const req = createRequest({
    headers: {
      'x-api-key': apiKey,
      'x-agroasys-timestamp': timestamp,
      'x-agroasys-nonce': nonce,
      'x-agroasys-signature': signature,
    },
  });
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.body, undefined);
  assert.deepEqual(consumeCalls, [[apiKey, nonce, 60]]);
  assert.deepEqual(req.serviceAuth, { apiKeyId: apiKey, scheme: 'api_key' });
});

test('service auth middleware rejects replayed nonces', async () => {
  const secret = 'top-secret';
  const timestamp = '1700000000';
  const nonce = 'nonce-1';
  const canonical = buildServiceAuthCanonicalString({
    method: 'POST',
    path: '/internal/settlement',
    query: 'mode=test',
    bodySha256: '4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93',
    timestamp,
    nonce,
  });
  const signature = signServiceAuthCanonicalString(secret, canonical);
  let replayRejects = 0;

  const middleware = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: 30,
    nonceTtlSeconds: 60,
    nowSeconds: () => Number(timestamp),
    lookupApiKey: () => ({ id: 'gateway', secret, active: true }),
    consumeNonce: async () => false,
    onReplayReject: () => {
      replayRejects += 1;
    },
  });

  const req = createRequest({
    headers: {
      'x-api-key': 'gateway',
      'x-agroasys-timestamp': timestamp,
      'x-agroasys-nonce': nonce,
      'x-agroasys-signature': signature,
    },
  });
  const res = createResponseRecorder();

  await middleware(req, res, () => {});

  assert.equal(replayRejects, 1);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, {
    success: false,
    code: 'AUTH_NONCE_REPLAY',
    error: 'Replay detected for nonce',
  });
});
