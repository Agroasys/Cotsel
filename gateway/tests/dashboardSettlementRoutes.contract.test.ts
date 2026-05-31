/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSession, AuthSessionClient } from '../src/core/authSessionClient';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessSettlementExecutionService,
} from '../src/core/gaslessSettlementExecutionService';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import type {
  SettlementExecutionEventRecord,
  SettlementHandoffRecord,
} from '../src/core/settlementStore';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createDashboardSettlementRouter } from '../src/routes/dashboardSettlement';
import { sendInProcessRequest } from './support/inProcessHttp';

const requestId = 'req-dashboard-create-trade';
const isoNow = '2026-03-14T10:00:00.000Z';

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
  chainId: 84532,
  escrowAddress: '0x00000000000000000000000000000000000000ee',
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
  gaslessExecutionEnabled: true,
  commitSha: 'abc1234',
  buildTime: isoNow,
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const handoff: SettlementHandoffRecord = {
  handoffId: 'handoff-247',
  platformId: 'agroasys',
  platformHandoffId: 'platform-247',
  tradeId: 'TRD-247',
  phase: 'locked',
  settlementChannel: 'cotsel_escrow',
  displayCurrency: 'USDC',
  displayAmount: 1200,
  assetSymbol: 'USDC',
  assetAmount: 1200,
  ricardianHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  externalReference: 'order-247',
  metadata: {},
  executionStatus: 'submitted',
  reconciliationStatus: 'pending',
  callbackStatus: 'pending',
  providerStatus: 'gasless_broadcast_submitted',
  txHash: '0xsettlement',
  latestEventId: 'evt-submitted',
  latestEventType: 'submitted',
  latestEventDetail: 'Gasless create-trade transaction submitted by Cotsel.',
  latestEventAt: isoNow,
  callbackDeliveredAt: null,
  requestId,
  sourceApiKeyId: null,
  createdAt: isoNow,
  updatedAt: isoNow,
};

function event(eventId: string, eventType: SettlementExecutionEventRecord['eventType']) {
  return {
    eventId,
    handoffId: handoff.handoffId,
    eventType,
    executionStatus:
      eventType === 'accepted' ? 'accepted' : eventType === 'submitted' ? 'submitted' : 'queued',
    reconciliationStatus: 'pending',
    providerStatus: `gasless_${eventType}`,
    txHash: eventType === 'submitted' ? '0xsettlement' : null,
    detail: `Event ${eventType}`,
    metadata: {},
    observedAt: isoNow,
    requestId,
    sourceApiKeyId: null,
    createdAt: isoNow,
  } satisfies SettlementExecutionEventRecord;
}

const executionResult = {
  handoff,
  acceptedEvent: event('evt-accepted', 'accepted'),
  queuedEvent: event('evt-queued', 'queued'),
  simulationEvent: event('evt-simulation', 'simulation_completed'),
  submittedEvent: event('evt-submitted', 'submitted'),
  txHash: '0xsettlement',
};

const validPayload: Omit<GaslessCreateTradeExecutionInput, 'requestId' | 'sourceApiKeyId'> = {
  action: 'create_trade',
  handoffId: 'handoff-247',
  chainId: 84532,
  contractAddress: '0x00000000000000000000000000000000000000ee',
  expiresAt: '2026-03-14T10:15:00.000Z',
  payloadHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  buyerAddress: '0x00000000000000000000000000000000000000b1',
  supplierAddress: '0x00000000000000000000000000000000000000c1',
  totalAmount: '1200000000',
  logisticsAmount: '35000000',
  platformFeesAmount: '16000000',
  supplierFirstTranche: '574500000',
  supplierSecondTranche: '574500000',
  ricardianHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  buyerAuthorization: {
    nonce: '1',
    deadline: '1773492000',
    signature: `0x${'11'.repeat(65)}`,
  },
  usdcAuthorization: {
    from: '0x00000000000000000000000000000000000000b1',
    to: '0x00000000000000000000000000000000000000ee',
    value: '1200000000',
    validAfter: '0',
    validBefore: '1773492000',
    nonce: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    v: 27,
    r: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    s: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  },
};

function buildSession(role: AuthSession['role'], userId: string): AuthSession {
  return {
    userId,
    walletAddress: '0x00000000000000000000000000000000000000aa',
    role,
    capabilities: [],
    signerAuthorizations: [],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

async function startServer(
  input: {
    session?: AuthSession | null;
    config?: Partial<GatewayConfig>;
    service?: Partial<GaslessSettlementExecutionService> | null;
  } = {},
) {
  const config: GatewayConfig = {
    ...baseConfig,
    ...input.config,
  };
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest
      .fn()
      .mockResolvedValue(input.session ?? buildSession('admin', 'uid-admin')),
    checkReadiness: jest.fn(),
  };
  const gaslessSettlementService =
    input.service === null
      ? null
      : ({
          executeCreateTrade: jest.fn().mockResolvedValue(executionResult),
          ...input.service,
        } as unknown as GaslessSettlementExecutionService);
  const router = Router();
  router.use(
    createDashboardSettlementRouter({
      authSessionClient,
      config,
      gaslessSettlementService,
      idempotencyStore: createInMemoryIdempotencyStore(),
    }),
  );
  const app = createApp(config, {
    version: '1.0.0-test',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: jest.fn().mockResolvedValue([]),
    extraRouter: router,
  });

  return { app, authSessionClient, gaslessSettlementService };
}

async function postCreateTrade(
  app: ReturnType<typeof createApp>,
  input: {
    token?: string;
    idempotencyKey?: string;
    body?: unknown;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': requestId,
  };
  if (input.token !== undefined) {
    headers.authorization = `Bearer ${input.token}`;
  }
  if (input.idempotencyKey !== undefined) {
    headers['idempotency-key'] = input.idempotencyKey;
  }

  return sendInProcessRequest(app, {
    method: 'POST',
    path: '/api/dashboard-gateway/v1/dashboard-settlement/gasless-executions/create-trade',
    headers,
    body: JSON.stringify(input.body ?? validPayload),
  });
}

describe('dashboard gasless create-trade route contract', () => {
  test('OpenAPI spec exposes the dashboard-authenticated gasless create-trade route', () => {
    const spec = loadOpenApiSpec();

    expect(
      hasOperation(spec, 'post', '/dashboard-settlement/gasless-executions/create-trade'),
    ).toBe(true);
  });

  test('rejects unauthenticated dashboard submissions', async () => {
    const { app, gaslessSettlementService } = await startServer({ session: null });
    const response = await postCreateTrade(app, {
      idempotencyKey: 'idem-unauthenticated',
    });

    expect(response.status).toBe(401);
    expect(gaslessSettlementService?.executeCreateTrade).not.toHaveBeenCalled();
  });

  test('rejects non-operator sessions before execution', async () => {
    const { app, gaslessSettlementService } = await startServer({
      session: buildSession('buyer', 'uid-buyer'),
    });
    const response = await postCreateTrade(app, {
      token: 'sess-buyer',
      idempotencyKey: 'idem-buyer',
    });

    expect(response.status).toBe(403);
    expect(gaslessSettlementService?.executeCreateTrade).not.toHaveBeenCalled();
  });

  test('rejects admin sessions when mutation write posture is disabled or not allowlisted', async () => {
    const { app, gaslessSettlementService } = await startServer({
      config: { writeAllowlist: [] },
    });
    const response = await postCreateTrade(app, {
      token: 'sess-admin',
      idempotencyKey: 'idem-not-allowlisted',
    });

    expect(response.status).toBe(403);
    expect(gaslessSettlementService?.executeCreateTrade).not.toHaveBeenCalled();
  });

  test('requires an idempotency key for dashboard create-trade submissions', async () => {
    const { app, gaslessSettlementService } = await startServer();
    const response = await postCreateTrade(app, {
      token: 'sess-admin',
    });

    expect(response.status).toBe(400);
    expect(gaslessSettlementService?.executeCreateTrade).not.toHaveBeenCalled();
  });

  test('fails closed when gasless execution is disabled', async () => {
    const { app, gaslessSettlementService } = await startServer({
      config: { gaslessExecutionEnabled: false },
    });
    const response = await postCreateTrade(app, {
      token: 'sess-admin',
      idempotencyKey: 'idem-gasless-disabled',
    });

    expect(response.status).toBe(503);
    expect(gaslessSettlementService?.executeCreateTrade).not.toHaveBeenCalled();
  });

  test('rejects malformed signed package payloads before execution', async () => {
    const { app, gaslessSettlementService } = await startServer();
    const response = await postCreateTrade(app, {
      token: 'sess-admin',
      idempotencyKey: 'idem-malformed',
      body: {
        ...validPayload,
        buyerAuthorization: {
          ...validPayload.buyerAuthorization,
          unexpected: 'not-allowed',
        },
      },
    });

    expect(response.status).toBe(400);
    expect(gaslessSettlementService?.executeCreateTrade).not.toHaveBeenCalled();
  });

  test('accepts a valid dashboard package and passes it to the existing execution service', async () => {
    const spec = loadOpenApiSpec();
    const validateResponse = createSchemaValidator(
      spec,
      '#/components/schemas/SettlementGaslessCreateTradeExecutionResponse',
    );
    const { app, gaslessSettlementService } = await startServer();
    const response = await postCreateTrade(app, {
      token: 'sess-admin',
      idempotencyKey: 'idem-valid-create-trade',
    });
    const payload = response.json<Record<string, unknown>>();

    expect(response.status).toBe(202);
    expect(validateResponse(payload)).toBe(true);
    expect(gaslessSettlementService?.executeCreateTrade).toHaveBeenCalledWith({
      ...validPayload,
      requestId,
      sourceApiKeyId: null,
    } satisfies GaslessCreateTradeExecutionInput);
  });
});
