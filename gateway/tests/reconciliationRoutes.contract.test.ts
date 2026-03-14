/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createReconciliationRouter } from '../src/routes/reconciliation';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { ReconciliationReadReader } from '../src/core/reconciliationReadService';
import { sendInProcessRequest } from './support/inProcessHttp';

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

const listFixture = {
  items: [
    {
      handoffId: 'sth-1',
      tradeId: 'TRD-9001',
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-1',
      phase: 'stage_1',
      settlementChannel: 'web3layer_escrow',
      displayCurrency: 'USD',
      displayAmount: 125000,
      assetSymbol: 'USDC',
      assetAmount: 125000,
      ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      externalReference: 'EXT-1',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      callbackStatus: 'pending',
      providerStatus: 'dispatch_received',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      extrinsicHash: null,
      latestEventType: 'submitted',
      latestEventDetail: 'Dispatch accepted by settlement engine.',
      latestEventAt: '2026-03-14T09:15:00.000Z',
      callbackDeliveredAt: null,
      createdAt: '2026-03-14T09:00:00.000Z',
      updatedAt: '2026-03-14T09:15:00.000Z',
      tradeProjection: {
        handoffId: 'sth-1',
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        phase: 'stage_1',
        settlementChannel: 'web3layer_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        callbackStatus: 'pending',
        providerStatus: 'dispatch_received',
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extrinsicHash: null,
        externalReference: 'EXT-1',
        latestEventType: 'submitted',
        latestEventDetail: 'Dispatch accepted by settlement engine.',
        latestEventAt: '2026-03-14T09:15:00.000Z',
        callbackDeliveredAt: null,
        createdAt: '2026-03-14T09:00:00.000Z',
        updatedAt: '2026-03-14T09:15:00.000Z',
      },
    },
  ],
  pagination: {
    limit: 20,
    offset: 0,
    total: 1,
  },
  freshness: {
    source: 'gateway_settlement_ledger',
    sourceFreshAt: '2026-03-14T09:15:00.000Z',
    queriedAt: '2026-03-14T09:16:00.000Z',
    available: true,
  },
};

const detailFixture = {
  handoff: listFixture.items[0],
  events: [
    {
      eventId: 'evt-1',
      handoffId: 'sth-1',
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'dispatch_received',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      extrinsicHash: null,
      detail: 'Dispatch accepted by settlement engine.',
      metadata: { queue: 'primary' },
      observedAt: '2026-03-14T09:15:00.000Z',
      requestId: 'req-event-1',
      sourceApiKeyId: 'platform-main',
      createdAt: '2026-03-14T09:15:05.000Z',
    },
  ],
  freshness: {
    source: 'gateway_settlement_ledger',
    sourceFreshAt: '2026-03-14T09:15:00.000Z',
    queriedAt: '2026-03-14T09:16:00.000Z',
    available: true,
  },
};

async function startServer(role: 'admin' | 'buyer' | null, overrides?: Partial<ReconciliationReadReader>) {
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
        expiresAt: Date.now() + 60000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const reconciliationReadService: ReconciliationReadReader = {
    listReconciliation: jest.fn().mockResolvedValue(listFixture),
    getReconciliationHandoff: jest.fn().mockImplementation(async (handoffId: string) => (
      handoffId === 'sth-1'
        ? detailFixture
        : {
            handoff: null,
            events: [],
            freshness: {
              source: 'gateway_settlement_ledger',
              sourceFreshAt: null,
              queriedAt: '2026-03-14T09:16:00.000Z',
              available: true,
            },
          }
    )),
    ...overrides,
  };

  const router = Router();
  router.use(createReconciliationRouter({
    authSessionClient,
    config,
    reconciliationReadService,
  }));

  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  return app;
}

describe('gateway reconciliation routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateList = createSchemaValidator(spec, '#/components/schemas/ReconciliationListResponse');
  const validateDetail = createSchemaValidator(spec, '#/components/schemas/ReconciliationDetailResponse');

  test('OpenAPI spec exposes reconciliation read endpoints', () => {
    expect(hasOperation(spec, 'get', '/reconciliation')).toBe(true);
    expect(hasOperation(spec, 'get', '/reconciliation/handoffs/{handoffId}')).toBe(true);
  });

  test('GET /reconciliation returns schema-valid records', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(
      app,
      {
        method: 'GET',
        path: '/api/dashboard-gateway/v1/reconciliation?tradeId=TRD-9001&reconciliationStatus=pending&executionStatus=submitted&limit=20&offset=0',
        headers: {
          authorization: 'Bearer sess-admin',
          'x-request-id': 'req-reconciliation-list',
        },
      },
    );
    const payload = response.json<{ data: { items: Array<{ handoffId: string }> } }>();

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-reconciliation-list');
    expect(validateList(payload)).toBe(true);
    expect(payload.data.items[0].handoffId).toBe('sth-1');
  });

  test('GET /reconciliation/handoffs/{handoffId} returns detail and 404s for missing handoffs', async () => {
    const app = await startServer('admin');
    const detailResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/reconciliation/handoffs/sth-1',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const detailPayload = detailResponse.json<{ data: { events: unknown[] } }>();

    expect(detailResponse.status).toBe(200);
    expect(validateDetail(detailPayload)).toBe(true);
    expect(detailPayload.data.events).toHaveLength(1);

    const missingResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/reconciliation/handoffs/missing',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const missingPayload = missingResponse.json<{ error: { code: string } }>();

    expect(missingResponse.status).toBe(404);
    expect(missingPayload.error.code).toBe('NOT_FOUND');
  });

  test('GET /reconciliation returns degraded payloads when the reconciliation source is unavailable', async () => {
    const app = await startServer('admin', {
      listReconciliation: jest.fn().mockResolvedValue({
        items: [],
        pagination: { limit: 50, offset: 0, total: 0 },
        freshness: {
          source: 'gateway_settlement_ledger',
          sourceFreshAt: null,
          queriedAt: '2026-03-14T09:16:00.000Z',
          available: false,
          degradedReason: 'connection refused',
        },
      }),
    });

    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/reconciliation',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const payload = response.json<{ data: { freshness: { available: boolean; degradedReason?: string } } }>();

    expect(response.status).toBe(200);
    expect(validateList(payload)).toBe(true);
    expect(payload.data.freshness.available).toBe(false);
    expect(payload.data.freshness.degradedReason).toBe('connection refused');
  });

  test('GET /reconciliation enforces authz and validates query parameters', async () => {
    const unauthenticatedApp = await startServer(null);
    const unauthenticated = await sendInProcessRequest(unauthenticatedApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/reconciliation',
    });
    expect(unauthenticated.status).toBe(401);

    const forbiddenApp = await startServer('buyer');
    const forbidden = await sendInProcessRequest(forbiddenApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/reconciliation',
      headers: { authorization: 'Bearer sess-buyer' },
    });
    expect(forbidden.status).toBe(403);

    const app = await startServer('admin');
    const invalidStatus = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/reconciliation?reconciliationStatus=broken',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(invalidStatus.status).toBe(400);

    const invalidOffset = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/reconciliation?offset=-1',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(invalidOffset.status).toBe(400);
  });
});
