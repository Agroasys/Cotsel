'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInMemoryNonceStore,
  createPostgresNonceStore,
} = require('./nonceStore');

test('in-memory nonce store rejects replays until ttl expires', async () => {
  let now = 1_000;
  const store = createInMemoryNonceStore({ nowMs: () => now });

  assert.equal(await store.consume('svc', 'nonce-1', 10), true);
  assert.equal(await store.consume('svc', 'nonce-1', 10), false);

  now += 11_000;
  assert.equal(await store.consume('svc', 'nonce-1', 10), true);
});

test('in-memory nonce store prunes expired entries before enforcing max size', async () => {
  let now = 1_000;
  const store = createInMemoryNonceStore({ nowMs: () => now, maxEntries: 2 });

  assert.equal(await store.consume('svc', 'nonce-1', 1), true);
  assert.equal(await store.consume('svc', 'nonce-2', 1), true);
  now += 2_000;
  assert.equal(await store.consume('svc', 'nonce-3', 1), true);

  assert.equal(store.size(), 1);
});

test('postgres nonce store uses a single conflict-safe insert query', async () => {
  const calls = [];
  const store = createPostgresNonceStore({
    tableName: 'trusted_session_exchange_nonces',
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ accepted: true }] };
    },
  });

  const accepted = await store.consume('svc', 'nonce-1', 30);

  assert.equal(accepted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO "trusted_session_exchange_nonces"/);
  assert.deepEqual(calls[0].params, ['svc', 'nonce-1', 30]);
});
