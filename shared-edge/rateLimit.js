'use strict';

const crypto = require('crypto');
const Redis = require('ioredis');

function fallbackLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function validateWindow(window) {
  if (!window || typeof window.limit !== 'number' || window.limit <= 0) {
    throw new Error('Rate limit value must be > 0');
  }

  if (typeof window.windowSeconds !== 'number' || window.windowSeconds <= 0) {
    throw new Error('Rate limit window must be > 0');
  }
}

function normalizeRoutePath(pathname) {
  if (pathname.length <= 1) {
    return pathname;
  }

  const normalized = pathname.replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

class InMemoryRateLimitStore {
  constructor() {
    this.buckets = new Map();
  }

  async incrementAndGet(key, windowSeconds, nowSeconds) {
    const bucketKey = `${key}:${windowSeconds}`;
    const existing = this.buckets.get(bucketKey);

    if (!existing || existing.expiresAt <= nowSeconds) {
      const expiresAt = nowSeconds + windowSeconds;
      this.buckets.set(bucketKey, { count: 1, expiresAt });
      return { count: 1, resetSeconds: windowSeconds };
    }

    existing.count += 1;
    return {
      count: existing.count,
      resetSeconds: Math.max(0, existing.expiresAt - nowSeconds),
    };
  }

  async close() {
    this.buckets.clear();
  }
}

class RedisRateLimitStore {
  constructor(redisUrl, keyPrefix) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    this.keyPrefix = keyPrefix;
  }

  async incrementAndGet(key, windowSeconds, nowSeconds) {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }

    const bucket = Math.floor(nowSeconds / windowSeconds);
    const redisKey = `${this.keyPrefix}:${key}:${windowSeconds}:${bucket}`;

    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, windowSeconds);
    }

    return {
      count,
      resetSeconds: windowSeconds - (nowSeconds % windowSeconds),
    };
  }

  async close() {
    await this.redis.quit();
  }
}

function defaultCallerContext(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const authContext = req.serviceAuth;

  if (authContext && authContext.apiKeyId) {
    const scopedIdentity = `apiKey:${authContext.apiKeyId}:ip:${ip}`;
    return {
      key: scopedIdentity,
      keyType: 'apiKey+ip',
      fingerprint: fingerprint(scopedIdentity),
    };
  }

  return {
    key: `ip:${ip}`,
    keyType: 'ip',
    fingerprint: fingerprint(ip),
  };
}

function setRateLimitHeaders(res, policy, currentWindow) {
  res.setHeader('RateLimit-Limit', String(currentWindow.limit));
  res.setHeader(
    'RateLimit-Remaining',
    String(Math.max(0, currentWindow.limit - currentWindow.count)),
  );
  res.setHeader('RateLimit-Reset', String(currentWindow.resetSeconds));
  res.setHeader(
    'RateLimit-Policy',
    `burst;w=${policy.burst.windowSeconds};limit=${policy.burst.limit}, sustained;w=${policy.sustained.windowSeconds};limit=${policy.sustained.limit}`,
  );
}

async function chooseStore(options, logger) {
  if (options.store) {
    return { store: options.store, mode: 'memory' };
  }

  if (!options.redisUrl) {
    if (options.nodeEnv === 'production') {
      throw new Error(
        `${options.keyPrefix.toUpperCase()}_RATE_LIMIT_REDIS_URL is required when rate limiting is enabled in production`,
      );
    }

    logger.warn('Rate limiter using in-memory store (local/dev fallback)', {
      keyPrefix: options.keyPrefix,
    });
    return {
      store: new InMemoryRateLimitStore(),
      mode: 'memory',
    };
  }

  const redisStore = new RedisRateLimitStore(options.redisUrl, options.keyPrefix);
  try {
    await redisStore.incrementAndGet('bootstrap', 1, Math.floor(Date.now() / 1000));
    return {
      store: redisStore,
      mode: 'redis',
    };
  } catch (error) {
    await redisStore.close();

    if (options.nodeEnv === 'production') {
      throw new Error(`Failed to connect rate limiter to Redis: ${error?.message || error}`, {
        cause: error,
      });
    }

    logger.warn('Rate limiter falling back to in-memory store after Redis connection failure', {
      keyPrefix: options.keyPrefix,
      error: error?.message || error,
    });

    return {
      store: new InMemoryRateLimitStore(),
      mode: 'memory',
    };
  }
}

async function createHttpRateLimiter(options) {
  const logger = options.logger || fallbackLogger();

  if (!options.enabled) {
    return {
      middleware(_req, _res, next) {
        next();
      },
      async close() {},
      mode: 'disabled',
    };
  }

  const nowSeconds = options.nowSeconds || (() => Math.floor(Date.now() / 1000));
  const resolveCaller = options.resolveCallerContext || defaultCallerContext;
  const { store, mode } = await chooseStore(options, logger);

  const middleware = async (req, res, next) => {
    try {
      if (req.method.toUpperCase() === 'OPTIONS') {
        next();
        return;
      }

      const policy = options.classifyRoute(req);
      if (!policy) {
        next();
        return;
      }

      validateWindow(policy.burst);
      validateWindow(policy.sustained);

      const caller = resolveCaller(req);
      const now = nowSeconds();
      const results = [];

      for (const [name, window] of [
        ['burst', policy.burst],
        ['sustained', policy.sustained],
      ]) {
        const result = await store.incrementAndGet(
          `${policy.name}:${caller.key}:${name}`,
          window.windowSeconds,
          now,
        );
        results.push({
          name,
          limit: window.limit,
          count: result.count,
          resetSeconds: result.resetSeconds,
        });
      }

      const currentWindow = results[results.length - 1];
      const blockedWindow = results.find((result) => result.count > result.limit);

      setRateLimitHeaders(res, policy, blockedWindow || currentWindow);

      if (blockedWindow) {
        logger.warn('Rate limit exceeded', {
          keyPrefix: options.keyPrefix,
          route: policy.name,
          method: req.method.toUpperCase(),
          callerFingerprint: caller.fingerprint,
          callerKeyType: caller.keyType,
          window: blockedWindow.name,
          limit: blockedWindow.limit,
          resetSeconds: blockedWindow.resetSeconds,
        });

        res.setHeader('Retry-After', String(blockedWindow.resetSeconds));
        res.status(429).json({
          success: false,
          error: 'Rate limit exceeded. Retry after the provided delay.',
          retryAfterSeconds: blockedWindow.resetSeconds,
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Rate limiter failed', {
        keyPrefix: options.keyPrefix,
        method: req.method.toUpperCase(),
        path: req.path,
        error: error?.message || error,
      });

      res.status(503).json({
        success: false,
        error: 'Rate limiting unavailable',
      });
    }
  };

  return {
    middleware,
    async close() {
      await store.close();
    },
    mode,
  };
}

module.exports = {
  createHttpRateLimiter,
  normalizeRoutePath,
};
