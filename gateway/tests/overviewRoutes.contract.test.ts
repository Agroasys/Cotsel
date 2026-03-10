/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createOverviewRouter } from '../src/routes/overview';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { OverviewReader, OverviewSnapshot } from '../src/core/overviewService';

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
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  commitSha: 'abc1234',
  buildTime: '2026-03-09T00:00:00.000Z',
  nodeEnv: 'test',
};

const overviewFixture: OverviewSnapshot = {
  kpis: {
    trades: {
      total: 5,
      byStatus: { locked: 1, stage_1: 2, stage_2: 1, completed: 1, disputed: 0 },
    },
    compliance: { blockedTrades: 1 },
  },
  posture: {
    paused: false,
    claimsPaused: false,
    oracleActive: true,
  },
  feedFreshness: {
    trades: { source: 'indexer_graphql', queriedAt: '2026-03-09T00:00:00.000Z', available: true },
    governance: { source: 'chain_rpc', queriedAt: '2026-03-09T00:00:00.000Z', available: true },
    compliance: { source: 'gateway_ledger', queriedAt: '2026-03-09T00:00:00.000Z', available: true },
  },
};

const degradedFixture: OverviewSnapshot = {
  kpis: {
    trades: {
      total: 0,
      byStatus: { locked: 0, stage_1: 0, stage_2: 0, completed: 0, disputed: 0 },
    },
    compliance: { blockedTrades: 0 },
  },
  posture: null,
  feedFreshness: {
    trades: { source: 'indexer_graphql', queriedAt: null, available: false },
    governance: { source: 'chain_rpc', queriedAt: null, available: false },
    compliance: { source: 'gateway_ledger', queriedAt: null, available: false },
  },
};

async function startServer(role: 'admin' | 'buyer' | null, fixture: OverviewSnapshot = overviewFixture) {
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

  const overviewService: OverviewReader = {
    getOverview: jest.fn().mockResolvedValue(fixture),
  };

  const router = Router();
  router.use(createOverviewRouter({ authSessionClient, config, overviewService }));

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

describe('gateway overview route contract', () => {
  const spec = loadOpenApiSpec();
  const validateOverview = createSchemaValidator(spec, '#/components/schemas/OverviewResponse');

  test('OpenAPI spec exposes overview endpoint', () => {
    expect(hasOperation(spec, 'get', '/overview')).toBe(true);
  });

  test('GET /overview returns schema-valid snapshot', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const response = await fetch(`${baseUrl}/overview`, {
        headers: { Authorization: 'Bearer sess-admin', 'x-request-id': 'req-overview' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('req-overview');
      expect(validateOverview(payload)).toBe(true);
      expect(payload.data.kpis.trades.total).toBe(5);
      expect(payload.data.kpis.trades.byStatus.stage_1).toBe(2);
      expect(payload.data.kpis.compliance.blockedTrades).toBe(1);
      expect(payload.data.posture.paused).toBe(false);
      expect(payload.data.posture.oracleActive).toBe(true);
      expect(payload.data.feedFreshness.trades.available).toBe(true);
      expect(payload.data.feedFreshness.governance.source).toBe('chain_rpc');
    } finally {
      server.close();
    }
  });

  test('GET /overview returns schema-valid degraded snapshot when all feeds unavailable', async () => {
    const { server, baseUrl } = await startServer('admin', degradedFixture);

    try {
      const response = await fetch(`${baseUrl}/overview`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateOverview(payload)).toBe(true);
      expect(payload.data.posture).toBeNull();
      expect(payload.data.kpis.trades.total).toBe(0);
      expect(payload.data.feedFreshness.trades.available).toBe(false);
      expect(payload.data.feedFreshness.governance.available).toBe(false);
      expect(payload.data.feedFreshness.compliance.available).toBe(false);
    } finally {
      server.close();
    }
  });

  test('GET /overview enforces authentication and operator:read role', async () => {
    const { server: unauthServer, baseUrl: unauthBaseUrl } = await startServer(null);
    try {
      const unauthResponse = await fetch(`${unauthBaseUrl}/overview`);
      expect(unauthResponse.status).toBe(401);
    } finally {
      unauthServer.close();
    }

    const { server: forbiddenServer, baseUrl: forbiddenBaseUrl } = await startServer('buyer');
    try {
      const forbiddenResponse = await fetch(`${forbiddenBaseUrl}/overview`, {
        headers: { Authorization: 'Bearer sess-buyer' },
      });
      expect(forbiddenResponse.status).toBe(403);
    } finally {
      forbiddenServer.close();
    }
  });
});
