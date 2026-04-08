/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createTradeRouter } from '../src/routes/trades';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { TradeReadReader, DashboardTradeRecord } from '../src/core/tradeReadService';

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
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
};

const tradeFixture: DashboardTradeRecord = {
  id: 'TRD-9001',
  buyer: 'buyer@demo',
  supplier: 'supplier@demo',
  amount: 125000,
  currency: 'USDC',
  status: 'stage_1',
  txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  createdAt: '2026-03-07T09:00:00.000Z',
  updatedAt: '2026-03-07T10:00:00.000Z',
  ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  platformFee: 1250,
  logisticsAmount: 3000,
  complianceStatus: 'pass',
  settlement: {
    handoffId: 'sth-1',
    platformId: 'agroasys-platform',
    platformHandoffId: 'handoff-1',
    phase: 'stage_1',
    settlementChannel: 'cotsel_escrow',
    displayCurrency: 'USD',
    displayAmount: 125000,
    executionStatus: 'submitted',
    reconciliationStatus: 'pending',
    callbackStatus: 'pending',
    providerStatus: 'dispatch_received',
    txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    externalReference: 'EXT-1',
    latestEventType: 'submitted',
    latestEventDetail: 'Dispatch accepted by settlement engine.',
    latestEventAt: '2026-03-07T09:15:00.000Z',
    callbackDeliveredAt: null,
    createdAt: '2026-03-07T09:00:00.000Z',
    updatedAt: '2026-03-07T09:15:00.000Z',
  },
  timeline: [
    {
      stage: 'Lock',
      timestamp: '2026-03-07T09:00:00.000Z',
      actor: 'Buyer',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      detail: 'Escrow locked for 125,000 USDC.',
    },
  ],
};

async function startServer(role: 'admin' | 'buyer' | null) {
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

  const tradeReadService: TradeReadReader = {
    checkReadiness: jest.fn(),
    listTrades: jest.fn().mockResolvedValue([tradeFixture]),
    getTrade: jest.fn().mockImplementation(async (tradeId: string) => (tradeId === tradeFixture.id ? tradeFixture : null)),
  };

  const router = Router();
  router.use(createTradeRouter({ authSessionClient, config, tradeReadService }));

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

describe('gateway trade routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateList = createSchemaValidator(spec, '#/components/schemas/TradeListResponse');
  const validateDetail = createSchemaValidator(spec, '#/components/schemas/TradeResponse');

  test('OpenAPI spec exposes trade read endpoints', () => {
    expect(hasOperation(spec, 'get', '/trades')).toBe(true);
    expect(hasOperation(spec, 'get', '/trades/{tradeId}')).toBe(true);
  });

  test('GET /trades returns schema-valid trade records', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const response = await fetch(`${baseUrl}/trades?limit=20&offset=0`, {
        headers: { Authorization: 'Bearer sess-admin', 'x-request-id': 'req-trades' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('req-trades');
      expect(validateList(payload)).toBe(true);
      expect(payload.data[0].id).toBe(tradeFixture.id);
    } finally {
      server.close();
    }
  });

  test('GET /trades/{tradeId} returns detail and 404s when missing', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const detailResponse = await fetch(`${baseUrl}/trades/${tradeFixture.id}`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const detailPayload = await detailResponse.json();

      expect(detailResponse.status).toBe(200);
      expect(validateDetail(detailPayload)).toBe(true);
      expect(detailPayload.data.timeline).toHaveLength(1);

      const missingResponse = await fetch(`${baseUrl}/trades/unknown`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const missingPayload = await missingResponse.json();

      expect(missingResponse.status).toBe(404);
      expect(missingPayload.error.code).toBe('NOT_FOUND');
    } finally {
      server.close();
    }
  });

  test('GET /trades enforces auth and validates pagination inputs', async () => {
    const { server: unauthenticatedServer, baseUrl: unauthenticatedBaseUrl } = await startServer(null);
    try {
      const unauthenticated = await fetch(`${unauthenticatedBaseUrl}/trades`);
      expect(unauthenticated.status).toBe(401);
    } finally {
      unauthenticatedServer.close();
    }

    const { server: forbiddenServer, baseUrl: forbiddenBaseUrl } = await startServer('buyer');
    try {
      const forbidden = await fetch(`${forbiddenBaseUrl}/trades`, {
        headers: { Authorization: 'Bearer sess-buyer' },
      });
      expect(forbidden.status).toBe(403);
    } finally {
      forbiddenServer.close();
    }

    const { server, baseUrl } = await startServer('admin');
    try {
      const invalidLimit = await fetch(`${baseUrl}/trades?limit=999`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      expect(invalidLimit.status).toBe(400);

      const invalidOffset = await fetch(`${baseUrl}/trades?offset=-1`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      expect(invalidOffset.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
