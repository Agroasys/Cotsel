/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import { AccessLogService } from '../src/core/accessLogService';
import { createInMemoryAccessLogStore } from '../src/core/accessLogStore';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createAccessLogRouter } from '../src/routes/accessLogs';

const baseConfig: GatewayConfig = {
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
  enableMutations: true,
  writeAllowlist: ['uid-admin'],
  governanceQueueTtlSeconds: 86400,
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
  buildTime: '2026-03-14T00:00:00.000Z',
  nodeEnv: 'test',
};

interface StartServerOptions {
  sessionRole?: 'admin' | 'buyer' | null;
  enableMutations?: boolean;
  writeAllowlist?: string[];
}

async function startServer(options: StartServerOptions = {}) {
  const config: GatewayConfig = {
    ...baseConfig,
    enableMutations: options.enableMutations ?? baseConfig.enableMutations,
    writeAllowlist: options.writeAllowlist ?? baseConfig.writeAllowlist,
  };

  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (options.sessionRole === null) {
        return null;
      }

      const role = options.sessionRole ?? 'admin';
      return {
        userId: role === 'admin' ? 'uid-admin' : 'uid-buyer',
        walletAddress: role === 'admin'
          ? '0x00000000000000000000000000000000000000aa'
          : '0x00000000000000000000000000000000000000bb',
        role,
        email: role === 'admin' ? 'admin@agroasys.io' : 'buyer@agroasys.io',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const accessLogService = new AccessLogService(createInMemoryAccessLogStore());
  const idempotencyStore = createInMemoryIdempotencyStore();

  const router = Router();
  router.use(createAccessLogRouter({
    authSessionClient,
    config,
    accessLogService,
    idempotencyStore,
  }));

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
  };
}

describe('gateway access log routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateEntry = createSchemaValidator(spec, '#/components/schemas/AccessLogEntryResponse');
  const validateList = createSchemaValidator(spec, '#/components/schemas/AccessLogListResponse');
  const validateError = createSchemaValidator(spec, '#/components/schemas/ErrorResponse');

  test('OpenAPI spec exposes access log routes', () => {
    expect(hasOperation(spec, 'post', '/access-logs')).toBe(true);
    expect(hasOperation(spec, 'get', '/access-logs')).toBe(true);
    expect(hasOperation(spec, 'get', '/access-logs/{entryId}')).toBe(true);
  });

  test('POST and GET access log routes satisfy the OpenAPI schema and preserve audit references', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const createResponse = await fetch(`${baseUrl}/access-logs`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-access-1',
        },
        body: JSON.stringify({
          eventType: 'settings.access.granted',
          surface: '/settings/security',
          outcome: 'allowed',
          auditReferences: [{ type: 'governance_action', reference: 'act-100' }],
          metadata: { section: 'security' },
        }),
      });
      const createPayload = await createResponse.json();

      expect(createResponse.status).toBe(201);
      expect(validateEntry(createPayload)).toBe(true);
      expect(createPayload.data.item.actor.sessionDisplay).toContain('...');
      expect(createPayload.data.item.network.ipDisplay).toBe('127.0.0.x');
      expect(createPayload.data.item.auditReferences[0]).toEqual({ type: 'governance_action', reference: 'act-100' });

      const detailResponse = await fetch(`${baseUrl}/access-logs/${createPayload.data.item.entryId}`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const detailPayload = await detailResponse.json();

      const listResponse = await fetch(`${baseUrl}/access-logs?eventType=settings.access.granted`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const listPayload = await listResponse.json();

      expect(detailResponse.status).toBe(200);
      expect(validateEntry(detailPayload)).toBe(true);
      expect(listResponse.status).toBe(200);
      expect(validateList(listPayload)).toBe(true);
      expect(listPayload.data.items).toHaveLength(1);
      expect(listPayload.data.freshness.available).toBe(true);
    } finally {
      server.close();
    }
  });

  test('access log writes require admin auth, allowlisting, and idempotency', async () => {
    const unauthenticated = await startServer({ sessionRole: null });
    const nonAdmin = await startServer({ sessionRole: 'buyer' });
    const disabled = await startServer({ enableMutations: false });

    try {
      const unauthenticatedResponse = await fetch(`${unauthenticated.baseUrl}/access-logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-access-2' },
        body: JSON.stringify({
          eventType: 'settings.access.granted',
          surface: '/settings/security',
          outcome: 'allowed',
        }),
      });
      expect(unauthenticatedResponse.status).toBe(401);

      const forbiddenResponse = await fetch(`${nonAdmin.baseUrl}/access-logs`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-buyer',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-access-3',
        },
        body: JSON.stringify({
          eventType: 'settings.access.granted',
          surface: '/settings/security',
          outcome: 'allowed',
        }),
      });
      expect(forbiddenResponse.status).toBe(403);

      const disabledResponse = await fetch(`${disabled.baseUrl}/access-logs`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-access-4',
        },
        body: JSON.stringify({
          eventType: 'settings.access.granted',
          surface: '/settings/security',
          outcome: 'allowed',
        }),
      });
      const disabledPayload = await disabledResponse.json();
      expect(disabledResponse.status).toBe(403);
      expect(validateError(disabledPayload)).toBe(true);
    } finally {
      unauthenticated.server.close();
      nonAdmin.server.close();
      disabled.server.close();
    }
  });
});
