/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import type { Server } from 'http';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { GatewayError } from '../src/errors';

const config: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://127.0.0.1:4350/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcFallbackUrls: [],
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  usdcAddress: '0x0000000000000000000000000000000000000888',
  enableMutations: false,
  writeAllowlist: [],
  governancePreparationTtlSeconds: 86400,
  settlementIngressEnabled: false,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  contractAddressRequired: true,
  allowInsecureDownstreamAuth: true,
};

async function withServer(extraRouter: Router) {
  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter,
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
  };
}

describe('gateway error envelope', () => {
  test('404 response omits path and query secrets', async () => {
    const { server, baseUrl } = await withServer(Router());
    try {
      const response = await fetch(`${baseUrl}/missing/token-secret?api_key=query-secret`, {
        headers: { 'x-request-id': 'req-missing-1234' },
      });
      const payload = await response.json();

      expect(response.status).toBe(404);
      expect(payload.error).toMatchObject({ code: 'NOT_FOUND', requestId: 'req-missing-1234' });
      expect(payload.error.details).toBeUndefined();
      expect(JSON.stringify(payload)).not.toMatch(/token-secret|query-secret|api_key/u);
    } finally {
      server.close();
    }
  });

  test('invalid caller correlation headers are replaced before reflection', async () => {
    const router = Router();
    router.get('/boom', () => {
      throw new Error('SQL password is private');
    });
    const { server, baseUrl } = await withServer(router);
    try {
      const response = await fetch(`${baseUrl}/boom`, {
        headers: {
          'x-request-id': 'secret=private',
          'x-correlation-id': 'https://provider.example/key-secret',
        },
      });
      const payload = await response.json();

      expect(response.status).toBe(500);
      expect(payload.error.requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(payload.error.traceId).toBe(payload.error.requestId);
      expect(JSON.stringify(payload)).not.toMatch(/private|provider\.example|key-secret/u);
      expect(response.headers.get('x-correlation-id')).toBe(payload.error.requestId);
    } finally {
      server.close();
    }
  });

  test('normalizes GatewayError instances', async () => {
    const router = Router();
    router.get('/boom', () => {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service is unavailable', {
        upstream: 'auth',
      });
    });

    const { server, baseUrl } = await withServer(router);

    try {
      const response = await fetch(`${baseUrl}/boom`, {
        headers: { 'x-request-id': 'req-boom', 'x-correlation-id': 'corr-boom' },
      });
      const payload = await response.json();

      expect(response.status).toBe(503);
      expect(payload.success).toBe(false);
      expect(payload.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(payload.error.requestId).toBe('req-boom');
      expect(payload.error.traceId).toBe('corr-boom');
      expect(payload.error.details).toEqual({ upstream: 'auth' });
    } finally {
      server.close();
    }
  });

  test('normalizes unexpected errors', async () => {
    const router = Router();
    router.get('/unexpected', () => {
      throw new Error('kaboom');
    });

    const { server, baseUrl } = await withServer(router);

    try {
      const response = await fetch(`${baseUrl}/unexpected`);
      const payload = await response.json();

      expect(response.status).toBe(500);
      expect(payload.success).toBe(false);
      expect(payload.error.code).toBe('INTERNAL_ERROR');
      expect(payload.error.requestId).toBeDefined();
    } finally {
      server.close();
    }
  });
});
