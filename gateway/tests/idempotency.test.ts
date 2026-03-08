/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import type { Server } from 'http';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { createIdempotencyMiddleware } from '../src/middleware/idempotency';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';

const config: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
};

async function startServer() {
  const router = Router();
  const store = createInMemoryIdempotencyStore();
  const mutationMiddleware = createIdempotencyMiddleware(store);
  let executionCount = 0;
  let failOnce = false;
  let slowMutationMs = 0;

  router.post('/test-mutation', mutationMiddleware, (_req, res) => {
    if (slowMutationMs > 0) {
      return setTimeout(() => {
        executionCount += 1;
        res.status(202).json({ success: true, executionCount });
      }, slowMutationMs);
    }

    executionCount += 1;
    if (failOnce) {
      failOnce = false;
      res.status(500).json({ success: false, executionCount });
      return;
    }
    res.status(202).json({ success: true, executionCount });
  });

  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
    getExecutionCount: () => executionCount,
    setFailOnce: () => {
      failOnce = true;
    },
    setSlowMutationMs: (ms: number) => {
      slowMutationMs = ms;
    },
  };
}

describe('gateway idempotency middleware', () => {
  test('replays the stored response for duplicate keys', async () => {
    const { server, baseUrl, getExecutionCount } = await startServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-1',
      };
      const body = JSON.stringify({ hello: 'world' });

      const first = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body });
      const secondPayload = await second.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers.get('x-idempotent-replay')).toBe('true');
      expect(firstPayload).toEqual(secondPayload);
      expect(getExecutionCount()).toBe(1);
    } finally {
      server.close();
    }
  });

  test('rejects reusing a key for a different payload', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-2',
      };

      await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ first: true }),
      });

      const response = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ first: false }),
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error.code).toBe('CONFLICT');
    } finally {
      server.close();
    }
  });

  test('requires Idempotency-Key on mutation routes', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ missing: true }),
      });
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe('VALIDATION_ERROR');
    } finally {
      server.close();
    }
  });

  test('releases failed reservations after a 5xx response', async () => {
    const { server, baseUrl, getExecutionCount, setFailOnce } = await startServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-retry-after-500',
      };
      setFailOnce();

      const first = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ retry: true }),
      });
      expect(first.status).toBe(500);

      const second = await fetch(`${baseUrl}/test-mutation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ retry: true }),
      });
      const secondPayload = await second.json();

      expect(second.status).toBe(202);
      expect(secondPayload.success).toBe(true);
      expect(getExecutionCount()).toBe(2);
    } finally {
      server.close();
    }
  });

  test('reserves a new idempotency key atomically under concurrent requests', async () => {
    const { server, baseUrl, getExecutionCount, setSlowMutationMs } = await startServer();

    try {
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-concurrent',
      };
      setSlowMutationMs(50);
      const body = JSON.stringify({ parallel: true });

      const [first, second] = await Promise.all([
        fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body }),
        fetch(`${baseUrl}/test-mutation`, { method: 'POST', headers, body }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([202, 409]);
      expect(getExecutionCount()).toBe(1);
    } finally {
      server.close();
    }
  });
});
