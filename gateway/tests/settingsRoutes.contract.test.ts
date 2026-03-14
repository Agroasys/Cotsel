/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import { createInMemoryAuditFeedStore } from '../src/core/auditFeedStore';
import { OperatorSettingsReadService } from '../src/core/operatorSettingsReadService';
import { createInMemoryRoleAssignmentStore } from '../src/core/roleAssignmentStore';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createSettingsRouter } from '../src/routes/settings';

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
  enableMutations: false,
  writeAllowlist: [],
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

async function startServer(role: 'admin' | 'buyer' | null = 'admin') {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (role === null) {
        return null;
      }

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

  const settingsReadService = new OperatorSettingsReadService(
    createInMemoryRoleAssignmentStore([
      {
        assignmentId: 'ra-1',
        subjectUserId: 'uid-admin',
        subjectWalletAddress: '0x00000000000000000000000000000000000000aa',
        authRole: 'admin',
        gatewayRoles: ['operator:read', 'operator:write'],
        source: 'manual_sync',
        assignedByUserId: 'uid-owner',
        assignedByWalletAddress: '0x00000000000000000000000000000000000000cc',
        assignedAt: '2026-03-14T10:00:00.000Z',
        lastVerifiedAt: '2026-03-14T12:00:00.000Z',
      },
    ]),
    createInMemoryAuditFeedStore([
      {
        eventId: '1',
        eventType: 'governance.action.recorded',
        route: '/api/dashboard-gateway/v1/governance/pause',
        method: 'POST',
        requestId: 'req-1',
        correlationId: 'corr-1',
        actor: {
          userId: 'uid-admin',
          walletAddress: '0x00000000000000000000000000000000000000aa',
          role: 'admin',
        },
        status: 'accepted',
        metadata: { category: 'pause' },
        source: 'audit_log',
        createdAt: '2026-03-14T11:00:00.000Z',
      },
    ]),
    () => new Date('2026-03-14T16:20:00.000Z'),
  );

  const router = Router();
  router.use(createSettingsRouter({
    authSessionClient,
    config,
    settingsReadService,
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

describe('gateway settings routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateRoleAssignments = createSchemaValidator(spec, '#/components/schemas/RoleAssignmentListResponse');
  const validateAuditFeed = createSchemaValidator(spec, '#/components/schemas/AuditFeedListResponse');

  test('OpenAPI spec exposes settings role-assignment and audit-feed routes', () => {
    expect(hasOperation(spec, 'get', '/settings/role-assignments')).toBe(true);
    expect(hasOperation(spec, 'get', '/settings/audit-feed')).toBe(true);
  });

  test('settings routes return schema-valid role assignments and audit feed payloads', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const rolesResponse = await fetch(`${baseUrl}/settings/role-assignments`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const rolesPayload = await rolesResponse.json();

      const auditFeedResponse = await fetch(`${baseUrl}/settings/audit-feed`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const auditFeedPayload = await auditFeedResponse.json();

      expect(rolesResponse.status).toBe(200);
      expect(validateRoleAssignments(rolesPayload)).toBe(true);
      expect(rolesPayload.data.items[0]?.subjectUserId).toBe('uid-admin');

      expect(auditFeedResponse.status).toBe(200);
      expect(validateAuditFeed(auditFeedPayload)).toBe(true);
      expect(auditFeedPayload.data.items[0]?.eventType).toBe('governance.action.recorded');
      expect(auditFeedPayload.data.freshness.available).toBe(true);
    } finally {
      server.close();
    }
  });

  test('settings routes require an authenticated admin session', async () => {
    const unauthenticated = await startServer(null);
    const nonAdmin = await startServer('buyer');

    try {
      const unauthenticatedResponse = await fetch(`${unauthenticated.baseUrl}/settings/role-assignments`);
      expect(unauthenticatedResponse.status).toBe(401);

      const forbiddenResponse = await fetch(`${nonAdmin.baseUrl}/settings/audit-feed`, {
        headers: { Authorization: 'Bearer session-buyer' },
      });
      expect(forbiddenResponse.status).toBe(403);
    } finally {
      unauthenticated.server.close();
      nonAdmin.server.close();
    }
  });
});
