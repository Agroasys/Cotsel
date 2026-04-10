/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createRicardianRouter } from '../src/routes/ricardian';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { EvidenceReadReader } from '../src/core/evidenceReadService';
import { GatewayError } from '../src/errors';
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
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const ricardianFixture = {
  tradeId: 'TRD-9001',
  ricardianHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  document: {
    id: 'doc-1',
    requestId: 'req-doc-1',
    documentRef: 'CTSL-TRD-9001',
    hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    rulesVersion: 'v1',
    canonicalJson: { tradeId: 'TRD-9001' },
    metadata: { issuer: 'ctsp' },
    createdAt: '2026-03-14T09:30:00.000Z',
  },
  verification: {
    status: 'verified',
    tradeHashMatchesDocument: true,
    settlementHashMatchesTrade: true,
  },
  freshness: {
    source: 'ricardian_http',
    sourceFreshAt: '2026-03-14T09:30:00.000Z',
    queriedAt: '2026-03-14T10:16:00.000Z',
    available: true,
  },
};

const evidenceFixture = {
  tradeId: 'TRD-9001',
  ricardianHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  settlement: {
    handoffId: 'sth-1',
    platformId: 'agroasys-platform',
    platformHandoffId: 'handoff-1',
    phase: 'stage_2',
    settlementChannel: 'web3layer_escrow',
    displayCurrency: 'USD',
    displayAmount: 125000,
    executionStatus: 'confirmed',
    reconciliationStatus: 'matched',
    callbackStatus: 'delivered',
    providerStatus: 'confirmed',
    txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    extrinsicHash: null,
    externalReference: 'EXT-1',
    latestEventType: 'reconciled',
    latestEventDetail: 'Settlement confirmed and reconciled.',
    latestEventAt: '2026-03-14T10:05:00.000Z',
    callbackDeliveredAt: '2026-03-14T10:06:00.000Z',
    createdAt: '2026-03-14T09:00:00.000Z',
    updatedAt: '2026-03-14T10:06:00.000Z',
  },
  complianceDecisions: [],
  governanceActions: [],
  freshness: {
    source: 'gateway_ledgers',
    sourceFreshAt: '2026-03-14T10:06:00.000Z',
    queriedAt: '2026-03-14T10:16:00.000Z',
    available: true,
  },
};

async function startServer(role: 'admin' | 'buyer' | null, overrides?: Partial<EvidenceReadReader>) {
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

  const evidenceReadService: EvidenceReadReader = {
    getRicardianDocument: jest.fn().mockImplementation(async (tradeId: string) => {
      if (tradeId === 'missing-hash') {
        throw new GatewayError(409, 'CONFLICT', 'Trade has no Ricardian hash');
      }

      return tradeId === 'TRD-9001'
        ? ricardianFixture
        : {
            tradeId,
            ricardianHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            document: null,
            verification: {
              status: 'unavailable',
              tradeHashMatchesDocument: null,
              settlementHashMatchesTrade: null,
            },
            freshness: {
              source: 'ricardian_http',
              sourceFreshAt: null,
              queriedAt: '2026-03-14T10:16:00.000Z',
              available: false,
              degradedReason: 'Ricardian service is unavailable',
            },
          };
    }),
    getTradeEvidence: jest.fn().mockResolvedValue(evidenceFixture),
    ...overrides,
  };

  const router = Router();
  router.use(createRicardianRouter({
    authSessionClient,
    config,
    evidenceReadService,
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

describe('gateway ricardian and evidence routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateRicardian = createSchemaValidator(spec, '#/components/schemas/RicardianDocumentResponse');
  const validateEvidence = createSchemaValidator(spec, '#/components/schemas/TradeEvidenceResponse');

  test('OpenAPI spec exposes ricardian and evidence read endpoints', () => {
    expect(hasOperation(spec, 'get', '/ricardian/{tradeId}')).toBe(true);
    expect(hasOperation(spec, 'get', '/evidence/{tradeId}')).toBe(true);
  });

  test('GET /ricardian/{tradeId} returns a schema-valid ricardian document payload', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/ricardian/TRD-9001',
      headers: {
        authorization: 'Bearer sess-admin',
        'x-request-id': 'req-ricardian',
      },
    });
    const payload = response.json<{ data: { verification: { status: string } } }>();

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-ricardian');
    expect(validateRicardian(payload)).toBe(true);
    expect(payload.data.verification.status).toBe('verified');
  });

  test('GET /ricardian/{tradeId} returns degraded payloads when the ricardian source is unavailable', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/ricardian/TRD-degraded',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const payload = response.json<{ data: { freshness: { available: boolean } } }>();

    expect(response.status).toBe(200);
    expect(validateRicardian(payload)).toBe(true);
    expect(payload.data.freshness.available).toBe(false);
  });

  test('GET /evidence/{tradeId} returns grouped evidence records', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/evidence/TRD-9001',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const payload = response.json<{ data: { tradeId: string } }>();

    expect(response.status).toBe(200);
    expect(validateEvidence(payload)).toBe(true);
    expect(payload.data.tradeId).toBe('TRD-9001');
  });

  test('ricardian and evidence routes require an authenticated admin session and fail closed on missing hashes', async () => {
    const unauthenticatedApp = await startServer(null);
    const unauthenticatedResponse = await sendInProcessRequest(unauthenticatedApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/ricardian/TRD-9001',
    });
    expect(unauthenticatedResponse.status).toBe(401);

    const nonAdminApp = await startServer('buyer');
    const forbiddenResponse = await sendInProcessRequest(nonAdminApp, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/ricardian/TRD-9001',
      headers: { authorization: 'Bearer sess-buyer' },
    });
    expect(forbiddenResponse.status).toBe(403);

    const app = await startServer('admin');
    const missingHashResponse = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/ricardian/missing-hash',
      headers: { authorization: 'Bearer sess-admin' },
    });
    const missingHashPayload = missingHashResponse.json<{ error: { code: string } }>();

    expect(missingHashResponse.status).toBe(409);
    expect(missingHashPayload.error.code).toBe('CONFLICT');
  });
});
