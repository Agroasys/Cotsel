/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createTreasuryRouter } from '../src/routes/treasury';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { TreasuryReadReader } from '../src/core/treasuryReadService';
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

const treasuryFixture = {
  state: {
    paused: false,
    claimsPaused: false,
    treasuryAddress: '0x0000000000000000000000000000000000000022',
    treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
    governanceApprovalsRequired: 2,
    governanceTimelockSeconds: 86400,
    requiredAdminCount: 2,
    claimableBalance: {
      assetSymbol: 'USDC',
      raw: '125000000',
      display: '125.0',
    },
    sweepVisibility: {
      canSweep: true,
      blockedReason: null,
    },
    payoutReceiverVisibility: {
      currentAddress: '0x0000000000000000000000000000000000000033',
      hasPendingUpdate: true,
      activeProposalIds: [11],
    },
  },
  freshness: {
    source: 'chain_rpc',
    sourceFreshAt: '2026-03-14T10:16:00.000Z',
    queriedAt: '2026-03-14T10:16:00.000Z',
    available: true,
  },
};

const treasuryActionsFixture = {
  items: [
    {
      actionId: 'gov-1',
      intentKey: 'v1|treasury_sweep|sweeptreasury||||31337|',
      proposalId: null,
      category: 'treasury_sweep',
      status: 'executed',
      contractMethod: 'sweepTreasury',
      txHash: '0xabc',
      extrinsicHash: null,
      blockNumber: 17,
      tradeId: null,
      chainId: '31337',
      targetAddress: null,
      createdAt: '2026-03-14T10:00:00.000Z',
      expiresAt: '2026-03-15T10:00:00.000Z',
      executedAt: '2026-03-14T10:01:00.000Z',
      requestId: 'req-1',
      correlationId: 'corr-1',
      errorCode: null,
      errorMessage: null,
      audit: {
        reason: 'Sweep treasury.',
        evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-1' }],
        ticketRef: 'AGRO-1',
        actorSessionId: 'sess-1',
        actorWallet: '0x00000000000000000000000000000000000000a1',
        actorRole: 'admin',
        createdAt: '2026-03-14T10:00:00.000Z',
        requestedBy: 'uid-admin-1',
      },
    },
  ],
  nextCursor: null,
  freshness: {
    source: 'gateway_governance_ledger',
    sourceFreshAt: '2026-03-14T10:01:00.000Z',
    queriedAt: '2026-03-14T10:16:00.000Z',
    available: true,
  },
};

async function startServer(role: 'admin' | 'buyer' | null, overrides?: Partial<TreasuryReadReader>) {
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

  const treasuryReadService: TreasuryReadReader = {
    getTreasurySnapshot: jest.fn().mockResolvedValue(treasuryFixture),
    listTreasuryActions: jest.fn().mockResolvedValue(treasuryActionsFixture),
    ...overrides,
  };

  const router = Router();
  router.use(createTreasuryRouter({
    authSessionClient,
    config,
    treasuryReadService,
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

describe('gateway treasury routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateSnapshot = createSchemaValidator(spec, '#/components/schemas/TreasurySnapshotResponse');
  const validateActions = createSchemaValidator(spec, '#/components/schemas/TreasuryActionListResponse');

  test('OpenAPI spec exposes treasury read endpoints', () => {
    expect(hasOperation(spec, 'get', '/treasury')).toBe(true);
    expect(hasOperation(spec, 'get', '/treasury/actions')).toBe(true);
  });

  test('GET /treasury returns a schema-valid treasury snapshot', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
      headers: {
        authorization: 'Bearer sess-admin',
        'x-request-id': 'req-treasury',
      },
    });
    const payload = response.json<{ data: { state: { sweepVisibility: { canSweep: boolean } } } }>();

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-treasury');
    expect(validateSnapshot(payload)).toBe(true);
    expect(payload.data.state.sweepVisibility.canSweep).toBe(true);
  });

  test('GET /treasury/actions returns treasury governance history', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/actions?category=treasury_sweep&status=executed&limit=20',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const payload = response.json<{ data: { items: Array<{ category: string }> } }>();

    expect(response.status).toBe(200);
    expect(validateActions(payload)).toBe(true);
    expect(payload.data.items[0].category).toBe('treasury_sweep');
  });

  test('GET /treasury returns degraded payloads when the chain source is unavailable', async () => {
    const app = await startServer('admin', {
      getTreasurySnapshot: jest.fn().mockResolvedValue({
        state: null,
        freshness: {
          source: 'chain_rpc',
          sourceFreshAt: null,
          queriedAt: '2026-03-14T10:16:00.000Z',
          available: false,
          degradedReason: 'rpc unavailable',
        },
      }),
    });

    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const payload = response.json<{ data: { freshness: { available: boolean } } }>();

    expect(response.status).toBe(200);
    expect(validateSnapshot(payload)).toBe(true);
    expect(payload.data.freshness.available).toBe(false);
  });

  test('treasury routes require an authenticated admin session and validate query parameters', async () => {
    const unauthenticatedApp = await startServer(null);
    const unauthenticatedResponse = await sendInProcessRequest(unauthenticatedApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
    });
    expect(unauthenticatedResponse.status).toBe(401);

    const nonAdminApp = await startServer('buyer');
    const forbiddenResponse = await sendInProcessRequest(nonAdminApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury',
      headers: { authorization: 'Bearer sess-buyer' },
    });
    expect(forbiddenResponse.status).toBe(403);

    const app = await startServer('admin');
    const invalidCategory = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/actions?category=broken',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(invalidCategory.status).toBe(400);

    const invalidCursor = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/treasury/actions?cursor=not-a-cursor',
      headers: { authorization: 'Bearer sess-admin' },
    });
    expect(invalidCursor.status).toBe(400);
  });
});
