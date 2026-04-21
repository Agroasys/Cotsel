/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient, AuthSession } from '../src/core/authSessionClient';
import { createInMemoryComplianceStore } from '../src/core/complianceStore';
import { GatewayEvidenceBundleService } from '../src/core/evidenceBundleService';
import { createInMemoryEvidenceBundleStore } from '../src/core/evidenceBundleStore';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import type { DashboardTradeRecord, TradeReadReader } from '../src/core/tradeReadService';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createEvidenceBundleRouter } from '../src/routes/evidenceBundles';
import { sendInProcessRequest } from './support/inProcessHttp';

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
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const trade: DashboardTradeRecord = {
  id: 'TRD-247',
  buyer: 'buyer-1',
  supplier: 'supplier-1',
  amount: 1200,
  currency: 'USDC',
  status: 'locked',
  txHash: '0xtrade',
  createdAt: '2026-03-14T09:00:00.000Z',
  updatedAt: '2026-03-14T09:30:00.000Z',
  ricardianHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  platformFee: 20,
  logisticsAmount: 35,
  timeline: [],
  complianceStatus: 'pass',
  settlement: {
    handoffId: 'handoff-247',
    platformId: 'agroasys',
    platformHandoffId: 'platform-247',
    phase: 'locked',
    settlementChannel: 'usdc',
    displayCurrency: 'USDC',
    displayAmount: 1200,
    executionStatus: 'confirmed',
    reconciliationStatus: 'matched',
    callbackStatus: 'delivered',
    providerStatus: 'ok',
    txHash: '0xsettlement',
    externalReference: 'ref-247',
    latestEventType: 'confirmed',
    latestEventDetail: 'Settled',
    latestEventAt: '2026-03-14T09:20:00.000Z',
    callbackDeliveredAt: '2026-03-14T09:25:00.000Z',
    createdAt: '2026-03-14T09:05:00.000Z',
    updatedAt: '2026-03-14T09:25:00.000Z',
  },
};

function buildTradeReader(): TradeReadReader {
  return {
    checkReadiness: jest.fn(),
    listTrades: jest.fn().mockResolvedValue([trade]),
    getTrade: jest.fn().mockResolvedValue(trade),
  };
}

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

  const sessions: Record<string, AuthSession> = {
    'sess-admin': {
      userId: 'uid-admin',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      role: 'admin',
      capabilities: [],
      signerAuthorizations: [],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    'sess-buyer': {
      userId: 'uid-buyer',
      walletAddress: '0x00000000000000000000000000000000000000bb',
      role: 'buyer',
      capabilities: [],
      signerAuthorizations: [],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  };

  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async (token: string) => {
      if (options.sessionRole === null) {
        return null;
      }

      if (options.sessionRole) {
        return options.sessionRole === 'admin' ? sessions['sess-admin'] : sessions['sess-buyer'];
      }

      return sessions[token] ?? null;
    }),
    checkReadiness: jest.fn(),
  };

  const complianceStore = createInMemoryComplianceStore([
    {
      decisionId: 'dec-1',
      tradeId: trade.id,
      decisionType: 'KYT',
      result: 'ALLOW',
      reasonCode: 'CMP_OK',
      provider: 'provider-a',
      providerRef: 'provider-ref-1',
      subjectId: 'subject-1',
      subjectType: 'trade',
      riskLevel: 'low',
      correlationId: 'corr-1',
      decidedAt: '2026-03-14T09:10:00.000Z',
      overrideWindowEndsAt: null,
      blockState: 'not_blocked',
      audit: {
        reason: 'Trade cleared by compliance.',
        evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-247' }],
        ticketRef: 'AGRO-247',
        actorSessionId: 'sess-comp',
        actorWallet: '0x00000000000000000000000000000000000000cc',
        actorRole: 'admin',
        createdAt: '2026-03-14T09:10:00.000Z',
        requestedBy: 'uid-compliance',
      },
    },
  ]);

  const evidenceBundleService = new GatewayEvidenceBundleService(
    createInMemoryEvidenceBundleStore(),
    buildTradeReader(),
    complianceStore,
    'http://127.0.0.1:3100/api/ricardian/v1',
    () => new Date('2026-03-14T10:00:00.000Z'),
  );

  const router = Router();
  router.use(
    createEvidenceBundleRouter({
      authSessionClient,
      config,
      evidenceBundleService,
      idempotencyStore: createInMemoryIdempotencyStore(),
    }),
  );

  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  return app;
}

describe('gateway evidence bundle routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateBundleResponse = createSchemaValidator(
    spec,
    '#/components/schemas/EvidenceBundleResponse',
  );

  test('OpenAPI spec exposes evidence bundle generation and retrieval routes', () => {
    expect(hasOperation(spec, 'post', '/evidence/bundles')).toBe(true);
    expect(hasOperation(spec, 'get', '/evidence/bundles/{bundleId}')).toBe(true);
    expect(hasOperation(spec, 'get', '/evidence/bundles/{bundleId}/download')).toBe(true);
  });

  test('POST /evidence/bundles generates a schema-valid bundle and GET retrieves it', async () => {
    const app = await startServer();
    const createResponse = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/evidence/bundles',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
        'idempotency-key': 'bundle-247',
        'x-request-id': 'req-evidence-create',
      },
      body: JSON.stringify({ tradeId: trade.id }),
    });
    const createPayload = createResponse.json<Record<string, unknown>>();

    expect(createResponse.status).toBe(201);
    expect(validateBundleResponse(createPayload)).toBe(true);
    expect(
      (createPayload as { data: { bundleId: string; trade: { id: string } } }).data.trade.id,
    ).toBe(trade.id);

    const getResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: `/api/dashboard-gateway/v1/evidence/bundles/${(createPayload as { data: { bundleId: string } }).data.bundleId}`,
      headers: {
        authorization: 'Bearer sess-admin',
        'x-request-id': 'req-evidence-get',
      },
    });
    const getPayload = getResponse.json<Record<string, unknown>>();

    expect(getResponse.status).toBe(200);
    expect(validateBundleResponse(getPayload)).toBe(true);
    expect((getPayload as { data: { bundleId: string } }).data.bundleId).toBe(
      (createPayload as { data: { bundleId: string } }).data.bundleId,
    );
  });

  test('GET /evidence/bundles/{bundleId}/download returns a JSON attachment', async () => {
    const app = await startServer();
    const createResponse = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/evidence/bundles',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
        'idempotency-key': 'bundle-247-download',
      },
      body: JSON.stringify({ tradeId: trade.id }),
    });
    const createPayload = createResponse.json<{ data: { bundleId: string } }>();

    const downloadResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: `/api/dashboard-gateway/v1/evidence/bundles/${createPayload.data.bundleId}/download`,
      headers: { authorization: 'Bearer sess-admin' },
    });
    const downloadPayload = downloadResponse.json<{ bundleId: string }>();

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers['content-disposition']).toContain(
      `evidence-bundle-${createPayload.data.bundleId}.json`,
    );
    expect(downloadPayload.bundleId).toBe(createPayload.data.bundleId);
  });

  test('generation remains behind the mutation safety gate', async () => {
    const app = await startServer({ enableMutations: false });
    const response = await sendInProcessRequest(app, {
      method: 'POST',
      path: '/api/dashboard-gateway/v1/evidence/bundles',
      headers: {
        authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
        'idempotency-key': 'bundle-247-disabled',
      },
      body: JSON.stringify({ tradeId: trade.id }),
    });
    const payload = response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe('FORBIDDEN');
  });
});
