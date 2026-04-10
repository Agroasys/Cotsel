'use strict';

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonEmpty(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`${name} is required`);
  }
}

function createInMemoryNonceStore(options = {}) {
  const maxEntries = options.maxEntries ?? 10000;
  const nowMs = options.nowMs ?? (() => Date.now());
  const store = new Map();

  const pruneExpired = (currentTime) => {
    for (const [key, expiresAt] of store.entries()) {
      if (expiresAt <= currentTime) {
        store.delete(key);
      }
    }
  };

  const capStoreSize = () => {
    while (store.size > maxEntries) {
      const firstKey = store.keys().next().value;
      if (!firstKey) {
        return;
      }
      store.delete(firstKey);
    }
  };

  return {
    consume: async (apiKey, nonce, ttlSeconds) => {
      assertNonEmpty(apiKey, 'apiKey');
      assertNonEmpty(nonce, 'nonce');
      assertPositiveInteger(ttlSeconds, 'nonce ttlSeconds');

      const currentTime = nowMs();
      pruneExpired(currentTime);

      const key = `${apiKey}:${nonce}`;
      const expiresAt = store.get(key);
      if (expiresAt && expiresAt > currentTime) {
        return false;
      }

      store.set(key, currentTime + ttlSeconds * 1000);
      capStoreSize();
      return true;
    },
    size: () => store.size,
    close: async () => undefined,
  };
}

function quoteIdentifier(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }

  return `"${name}"`;
}

function createPostgresNonceStore(options) {
  const tableName = quoteIdentifier(options.tableName);
  const apiKeyColumn = quoteIdentifier(options.apiKeyColumn ?? 'api_key');
  const nonceColumn = quoteIdentifier(options.nonceColumn ?? 'nonce');
  const expiresAtColumn = quoteIdentifier(options.expiresAtColumn ?? 'expires_at');
  const query = options.query;

  if (typeof query !== 'function') {
    throw new Error('Postgres nonce store requires a query function');
  }

  return {
    consume: async (apiKey, nonce, ttlSeconds) => {
      assertNonEmpty(apiKey, 'apiKey');
      assertNonEmpty(nonce, 'nonce');
      assertPositiveInteger(ttlSeconds, 'nonce ttlSeconds');

      const result = await query(
        `WITH pruned_nonce AS (
          DELETE FROM ${tableName}
          WHERE ${expiresAtColumn} <= NOW()
        ),
        consumed_nonce AS (
          INSERT INTO ${tableName} (${apiKeyColumn}, ${nonceColumn}, ${expiresAtColumn})
          VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))
          ON CONFLICT (${apiKeyColumn}, ${nonceColumn}) DO NOTHING
          RETURNING 1
        )
        SELECT EXISTS(SELECT 1 FROM consumed_nonce) AS accepted`,
        [apiKey, nonce, ttlSeconds],
      );

      return Boolean(result?.rows?.[0]?.accepted);
    },
    close: async () => undefined,
  };
}

function createRedisNonceStore(options) {
  const redisUrl = options.redisUrl;
  assertNonEmpty(redisUrl, 'redisUrl');

  const keyPrefix = options.keyPrefix ?? 'auth_nonce';
  const Redis = options.Redis ?? require('ioredis');
  const redis = options.redisClient ?? new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  const ownsClient = !options.redisClient;

  return {
    consume: async (apiKey, nonce, ttlSeconds) => {
      assertNonEmpty(apiKey, 'apiKey');
      assertNonEmpty(nonce, 'nonce');
      assertPositiveInteger(ttlSeconds, 'nonce ttlSeconds');

      if (redis.status === 'wait') {
        await redis.connect();
      }

      const key = `${keyPrefix}:${apiKey}:${nonce}`;
      const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    },
    close: async () => {
      if (!ownsClient) {
        return;
      }

      try {
        await redis.quit();
      } catch {
        redis.disconnect(false);
      }
    },
  };
}

module.exports = {
  createInMemoryNonceStore,
  createPostgresNonceStore,
  createRedisNonceStore,
};
