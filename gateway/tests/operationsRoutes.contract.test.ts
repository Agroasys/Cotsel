/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createOperationsRouter } from '../src/routes/operations';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type {
  OperationsSummaryReader,
  OperationsSummarySnapshot,
} from '../src/core/operationsSummaryService';

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
  buildTime: '2026-03-12T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const operationsFixture: OperationsSummarySnapshot = {
  state: 'degraded',
  generatedAt: '2026-03-12T00:00:00.000Z',
  services: [
    {
      key: 'oracle',
      name: 'Oracle',
      state: 'healthy',
      source: 'oracle_http',
      checkedAt: '2026-03-12T00:00:00.000Z',
      firstFailureAt: null,
      lastSuccessAt: '2026-03-12T00:00:00.000Z',
      freshnessMs: 0,
      staleAfterMs: 120000,
      latencyMs: 150,
    },
    {
      key: 'indexer',
      name: 'Indexer',
      state: 'degraded',
      source: 'indexer_graphql',
      checkedAt: '2026-03-12T00:00:00.000Z',
      firstFailureAt: null,
      lastSuccessAt: '2026-03-12T00:00:00.000Z',
      freshnessMs: 0,
      staleAfterMs: 120000,
      latencyMs: 2401,
      detail: 'Probe latency 2401ms exceeded degraded threshold 2000ms',
    },
    {
      key: 'notifications',
      name: 'Notifications',
      state: 'unavailable',
      source: 'notifications_http',
      checkedAt: '2026-03-12T00:00:00.000Z',
      firstFailureAt: null,
      lastSuccessAt: null,
      freshnessMs: null,
      staleAfterMs: 120000,
      latencyMs: null,
      detail: 'Gateway has no configured health probe for this service',
    },
    {
      key: 'reconciliation',
      name: 'Reconciliation',
      state: 'stale',
      source: 'reconciliation_http',
      checkedAt: '2026-03-12T00:00:00.000Z',
      firstFailureAt: '2026-03-11T23:50:00.000Z',
      lastSuccessAt: '2026-03-11T23:50:00.000Z',
      freshnessMs: 600000,
      staleAfterMs: 120000,
      latencyMs: 300,
      detail: 'Latest probe failed: Probe timeout after 5000ms',
    },
  ],
  incidents: {
    state: 'stale',
    source: 'gateway_derived',
    generatedAt: '2026-03-12T00:00:00.000Z',
    openCount: 3,
    bySeverity: {
      critical: 0,
      high: 1,
      medium: 1,
      low: 1,
    },
    items: [
      {
        incidentId: 'ops-indexer-degraded',
        title: 'Indexer is degraded',
        severity: 'low',
        state: 'open',
        sourceServiceKey: 'indexer',
        firstObservedAt: '2026-03-12T00:00:00.000Z',
        lastObservedAt: '2026-03-12T00:00:00.000Z',
      },
      {
        incidentId: 'ops-notifications-unavailable',
        title: 'Notifications is unavailable',
        severity: 'high',
        state: 'open',
        sourceServiceKey: 'notifications',
        firstObservedAt: '2026-03-12T00:00:00.000Z',
        lastObservedAt: '2026-03-12T00:00:00.000Z',
      },
      {
        incidentId: 'ops-reconciliation-stale',
        title: 'Reconciliation is stale',
        severity: 'medium',
        state: 'open',
        sourceServiceKey: 'reconciliation',
        firstObservedAt: '2026-03-11T23:50:00.000Z',
        lastObservedAt: '2026-03-12T00:00:00.000Z',
      },
    ],
  },
};

async function startServer(
  role: 'admin' | 'buyer' | null,
  fixture: OperationsSummarySnapshot = operationsFixture,
) {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (role === null) {
        return null;
      }

      return {
        userId: `uid-${role}`,
        walletAddress: '0x00000000000000000000000000000000000000aa',
        role,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const operationsSummaryService: OperationsSummaryReader = {
    getOperationsSummary: jest.fn().mockResolvedValue(fixture),
  };

  const router = Router();
  router.use(createOperationsRouter({ authSessionClient, config, operationsSummaryService }));

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

describe('gateway operations summary route contract', () => {
  const spec = loadOpenApiSpec();
  const validateOperationsSummary = createSchemaValidator(
    spec,
    '#/components/schemas/OperationsSummaryResponse',
  );

  test('OpenAPI spec exposes operations read endpoints', () => {
    expect(hasOperation(spec, 'get', '/operations')).toBe(true);
    expect(hasOperation(spec, 'get', '/operations/summary')).toBe(true);
  });

  test('GET /operations and /operations/summary return schema-valid snapshots', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const aliasResponse = await fetch(`${baseUrl}/operations`, {
        headers: { Authorization: 'Bearer sess-admin', 'x-request-id': 'req-ops-alias' },
      });
      const aliasPayload = await aliasResponse.json();
      const response = await fetch(`${baseUrl}/operations/summary`, {
        headers: { Authorization: 'Bearer sess-admin', 'x-request-id': 'req-ops-summary' },
      });
      const payload = await response.json();

      expect(aliasResponse.status).toBe(200);
      expect(aliasResponse.headers.get('x-request-id')).toBe('req-ops-alias');
      expect(validateOperationsSummary(aliasPayload)).toBe(true);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('req-ops-summary');
      expect(validateOperationsSummary(payload)).toBe(true);
      expect(payload.data.services[0].state).toBe('healthy');
      expect(payload.data.services[1].state).toBe('degraded');
      expect(payload.data.services[2].state).toBe('unavailable');
      expect(payload.data.services[3].state).toBe('stale');
      expect(payload.data.incidents.openCount).toBe(3);
      expect(payload.data.incidents.bySeverity.high).toBe(1);
      expect(payload.data.incidents.bySeverity.medium).toBe(1);
      expect(payload.data.incidents.bySeverity.low).toBe(1);
    } finally {
      server.close();
    }
  });

  test('GET /operations/summary enforces authentication and operator:read role', async () => {
    const { server: unauthServer, baseUrl: unauthBaseUrl } = await startServer(null);
    try {
      const unauthResponse = await fetch(`${unauthBaseUrl}/operations/summary`);
      expect(unauthResponse.status).toBe(401);
    } finally {
      unauthServer.close();
    }

    const { server: forbiddenServer, baseUrl: forbiddenBaseUrl } = await startServer('buyer');
    try {
      const forbiddenResponse = await fetch(`${forbiddenBaseUrl}/operations/summary`, {
        headers: { Authorization: 'Bearer sess-buyer' },
      });
      expect(forbiddenResponse.status).toBe(403);
    } finally {
      forbiddenServer.close();
    }
  });
});
