'use strict';

const { execFileSync } = require('node:child_process');
const { createHttpRateLimiter } = require('./rateLimit');

const REDIS_IMAGE = process.env.SHARED_EDGE_TEST_REDIS_IMAGE || 'redis:7-alpine';
let dockerAvailable = true;

try {
  execFileSync('docker', ['version'], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch {
  dockerAvailable = false;
}

function docker(args, options = {}) {
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return String(output ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRedis(containerName) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(['exec', containerName, 'redis-cli', 'ping']);
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await sleep(500);
    }
  }
}

async function withRedisContainer(fn) {
  const containerName = `cotsel-shared-edge-redis-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '-p',
    '127.0.0.1::6379',
    REDIS_IMAGE,
  ]);

  try {
    await waitForRedis(containerName);
    const port = docker(['port', containerName, '6379/tcp']).split(':').pop();
    await fn(`redis://127.0.0.1:${Number.parseInt(port, 10)}`, containerName);
  } finally {
    try {
      docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // best-effort cleanup
    }
  }
}

function createMockResponse() {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  response.setHeader = jest.fn();
  return response;
}

function createRequest() {
  return {
    method: 'POST',
    path: '/admin/profiles/provision',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };
}

const policy = {
  name: 'admin_control',
  burst: { limit: 1, windowSeconds: 60 },
  sustained: { limit: 10, windowSeconds: 300 },
};

describe('shared edge Redis rate limiter integration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  afterAll(async () => {
    await sleep(1100);
  });

  integrationTest(
    'independent limiter instances share Redis-backed quota',
    async () => {
      await withRedisContainer(async (redisUrl) => {
        const keyPrefix = `shared-edge-test-${Date.now()}`;
        const limiterA = await createHttpRateLimiter({
          enabled: true,
          redisUrl,
          nodeEnv: 'test',
          keyPrefix,
          classifyRoute: () => policy,
          nowSeconds: () => 1800000000,
        });
        const limiterB = await createHttpRateLimiter({
          enabled: true,
          redisUrl,
          nodeEnv: 'test',
          keyPrefix,
          classifyRoute: () => policy,
          nowSeconds: () => 1800000000,
        });

        try {
          const firstNext = jest.fn();
          await limiterA.middleware(createRequest(), createMockResponse(), firstNext);
          expect(firstNext).toHaveBeenCalledTimes(1);

          const blocked = createMockResponse();
          const secondNext = jest.fn();
          await limiterB.middleware(createRequest(), blocked, secondNext);
          expect(secondNext).not.toHaveBeenCalled();
          expect(blocked.status).toHaveBeenCalledWith(429);
        } finally {
          await limiterA.close();
          await limiterB.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'fails closed when the Redis-backed store becomes unavailable',
    async () => {
      await withRedisContainer(async (redisUrl, containerName) => {
        const onStoreError = jest.fn();
        const limiter = await createHttpRateLimiter({
          enabled: true,
          redisUrl,
          nodeEnv: 'test',
          keyPrefix: `shared-edge-fail-closed-${Date.now()}`,
          classifyRoute: () => policy,
          failOpenOnStoreError: false,
          onStoreError,
          nowSeconds: () => 1800000000,
        });

        docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
        await sleep(250);

        try {
          const response = createMockResponse();
          const next = jest.fn();
          await limiter.middleware(createRequest(), response, next);

          expect(next).not.toHaveBeenCalled();
          expect(response.status).toHaveBeenCalledWith(503);
          expect(onStoreError).toHaveBeenCalledWith(
            expect.objectContaining({
              failOpen: false,
            }),
          );
        } finally {
          await limiter.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'fails open only when explicitly configured for Redis store errors',
    async () => {
      await withRedisContainer(async (redisUrl, containerName) => {
        const onStoreError = jest.fn();
        const limiter = await createHttpRateLimiter({
          enabled: true,
          redisUrl,
          nodeEnv: 'test',
          keyPrefix: `shared-edge-fail-open-${Date.now()}`,
          classifyRoute: () => policy,
          failOpenOnStoreError: true,
          onStoreError,
          nowSeconds: () => 1800000000,
        });

        docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
        await sleep(250);

        try {
          const response = createMockResponse();
          const next = jest.fn();
          await limiter.middleware(createRequest(), response, next);

          expect(next).toHaveBeenCalledTimes(1);
          expect(response.status).not.toHaveBeenCalled();
          expect(onStoreError).toHaveBeenCalledWith(
            expect.objectContaining({
              failOpen: true,
            }),
          );
        } finally {
          await limiter.close();
        }
      });
    },
    120000,
  );
});
