/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import { createServiceApiKeyLookup, createServiceAuthHeaders } from '../src/core/serviceAuth';
import { SettlementService } from '../src/core/settlementService';
import { createInMemorySettlementStore } from '../src/core/settlementStore';
import {
  GaslessSettlementExecutionService,
  type GaslessExecutionSubmission,
  testExports as gaslessSettlementExecutionTestExports,
} from '../src/core/gaslessSettlementExecutionService';
import { createCapabilitiesRouter } from '../src/routes/capabilities';
import { createSettlementRouter } from '../src/routes/settlement';

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
  escrowAddress: '0x0000000000000000000000000000000000000999',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: true,
  settlementServiceAuthApiKeysJson: JSON.stringify([
    { id: 'platform-main', secret: 'super-secret', active: true },
  ]),
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  gaslessExecutionEnabled: true,
  gaslessExecutorPrivateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  gaslessMaxGasLimit: 1_500_000n,
  gaslessMinExecutorBalanceWei: 0n,
  gaslessRequestMaxTtlSeconds: 900,
  commitSha: 'abc1234',
  buildTime: '2026-03-11T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const buildConfirmedSubmission = (txHash: string): GaslessExecutionSubmission => ({
  txHash,
  receipt: {
    txHash,
    blockNumber: '12345',
    gasUsed: '210000',
    effectiveGasPriceWei: '1000000000',
    nativeCostWei: '210000000000000',
    executorAddress: '0x1111111111111111111111111111111111111111',
    executorBalanceWei: '1000000000000000000',
  },
});

async function startServer(
  overrides: Partial<GatewayConfig> = {},
  executorOverrides: Partial<{
    simulateCreateTrade: () => Promise<{ gasEstimate?: bigint | string | number | null }>;
    executeCreateTrade: () => Promise<GaslessExecutionSubmission>;
    simulateUserAction: () => Promise<{ gasEstimate?: bigint | string | number | null }>;
    executeUserAction: () => Promise<GaslessExecutionSubmission>;
  }> = {},
  serverOptions: Partial<{ includeProtectedRouterBeforeSettlement: boolean }> = {},
) {
  const runtimeConfig: GatewayConfig = { ...config, ...overrides };
  const settlementStore = createInMemorySettlementStore();
  const settlementService = new SettlementService(runtimeConfig, settlementStore);
  const gaslessSettlementService = new GaslessSettlementExecutionService(
    settlementService,
    settlementStore,
    {
      async executeCreateTrade() {
        return buildConfirmedSubmission(
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        );
      },
      async simulateCreateTrade() {
        return {
          gasEstimate: 500000n,
        };
      },
      async executeUserAction() {
        return buildConfirmedSubmission(
          '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        );
      },
      async simulateUserAction() {
        return {
          gasEstimate: 300000n,
        };
      },
      ...executorOverrides,
    },
    {
      chainId: runtimeConfig.chainId,
      escrowAddress: runtimeConfig.escrowAddress,
      requestMaxTtlSeconds: runtimeConfig.gaslessRequestMaxTtlSeconds ?? 900,
    },
  );
  const nonceStore = createInMemoryNonceStore();
  const idempotencyStore = createInMemoryIdempotencyStore();
  const router = Router();
  if (serverOptions.includeProtectedRouterBeforeSettlement) {
    router.use(
      createCapabilitiesRouter({
        authSessionClient: {
          async resolveSession() {
            throw new Error('operator auth should not run for settlement service routes');
          },
          async checkReadiness() {},
        },
        config: runtimeConfig,
      }),
    );
  }
  router.use(
    createSettlementRouter({
      config: runtimeConfig,
      settlementService,
      settlementStore,
      gaslessSettlementService,
      nonceStore,
      idempotencyStore,
      lookupServiceApiKey: createServiceApiKeyLookup(
        runtimeConfig.settlementServiceAuthApiKeysJson,
      ),
    }),
  );
  router.get('/after-settlement', (_req, res) => {
    res.status(200).json({ success: true });
  });

  const app = createApp(runtimeConfig, {
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

function withServiceAuth(path: string, body?: Record<string, unknown> | null, method = 'POST') {
  return createServiceAuthHeaders({
    apiKey: 'platform-main',
    apiSecret: 'super-secret',
    method,
    path,
    body: body ?? null,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: `nonce-${Math.random().toString(16).slice(2)}`,
  });
}

function buildGaslessCreateTradeBody(
  handoffId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const buyerAddress = '0x0000000000000000000000000000000000000200';
  const body = {
    action: 'create_trade' as const,
    handoffId,
    chainId: config.chainId,
    contractAddress: config.escrowAddress,
    expiresAt,
    buyerAddress,
    supplierAddress: '0x0000000000000000000000000000000000000100',
    totalAmount: '1000000000',
    logisticsAmount: '100000000',
    platformFeesAmount: '10000000',
    supplierFirstTranche: '445000000',
    supplierSecondTranche: '445000000',
    ricardianHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    buyerAuthorization: {
      nonce: '0',
      deadline: authorizationDeadline.toString(),
      signature:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    usdcAuthorization: {
      from: buyerAddress,
      to: config.escrowAddress,
      value: '1000000000',
      validAfter: '0',
      validBefore: authorizationDeadline.toString(),
      nonce: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      v: 27,
      r: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      s: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
    ...overrides,
  };

  return {
    ...body,
    payloadHash: gaslessSettlementExecutionTestExports.createPayloadHash(body),
  };
}

function buildGaslessUserActionBody(
  handoffId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const body = {
    action: 'open_dispute' as const,
    handoffId,
    chainId: config.chainId,
    contractAddress: config.escrowAddress,
    expiresAt,
    userAddress: '0x0000000000000000000000000000000000000200',
    tradeId: '42',
    userAuthorization: {
      nonce: '0',
      deadline: authorizationDeadline.toString(),
      signature:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    ...overrides,
  };

  return {
    ...body,
    payloadHash: gaslessSettlementExecutionTestExports.createPayloadHash(body),
  };
}

describe('gateway settlement routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateHandoffResponse = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementHandoffResponse',
  );
  const validateMutationResponse = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementExecutionEventMutationResponse',
  );
  const validateGaslessExecutionResponse = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementGaslessCreateTradeExecutionResponse',
  );
  const validateGaslessUserActionResponse = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementGaslessUserActionExecutionResponse',
  );
  const validateEventListResponse = createSchemaValidator(
    spec,
    '#/components/schemas/SettlementExecutionEventListResponse',
  );

  test('OpenAPI spec exposes settlement ingress routes', () => {
    expect(hasOperation(spec, 'post', '/settlement/handoffs')).toBe(true);
    expect(hasOperation(spec, 'post', '/settlement/gasless-executions/create-trade')).toBe(true);
    expect(hasOperation(spec, 'post', '/settlement/gasless-executions/user-action')).toBe(true);
    expect(hasOperation(spec, 'post', '/settlement/handoffs/{handoffId}/execution-events')).toBe(
      true,
    );
    expect(hasOperation(spec, 'get', '/settlement/handoffs/{handoffId}/execution-events')).toBe(
      true,
    );
  });

  test('gasless executor argument builders match escrow call order', () => {
    const body = buildGaslessCreateTradeBody('handoff-abi');

    const args = gaslessSettlementExecutionTestExports.buildCreateTradeArguments(body as never);
    const usdcAuthorization = body.usdcAuthorization as {
      validAfter: string;
      validBefore: string;
      nonce: string;
      v: number;
      r: string;
      s: string;
    };

    expect(args[0]).toBe(body.buyerAddress);
    expect(args[1]).toBe(body.supplierAddress);
    expect(args[11]).toEqual({
      validAfter: usdcAuthorization.validAfter,
      validBefore: usdcAuthorization.validBefore,
      nonce: usdcAuthorization.nonce,
      v: usdcAuthorization.v,
      r: usdcAuthorization.r,
      s: usdcAuthorization.s,
    });

    const userActionBody = buildGaslessUserActionBody('handoff-user-action-abi');
    const userActionArgs = gaslessSettlementExecutionTestExports.buildUserActionArguments(
      userActionBody as never,
    );
    expect(userActionArgs).toEqual([
      userActionBody.tradeId,
      (userActionBody.userAuthorization as { nonce: string }).nonce,
      (userActionBody.userAuthorization as { deadline: string }).deadline,
      (userActionBody.userAuthorization as { signature: string }).signature,
    ]);
  });

  test('settlement ingress disabled rejects requests instead of bypassing auth', async () => {
    const { server, baseUrl } = await startServer({ settlementIngressEnabled: false });

    try {
      const response = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-disabled',
        },
        body: JSON.stringify({
          platformId: 'agroasys-platform',
          platformHandoffId: 'handoff-disabled',
          tradeId: 'TRD-disabled',
          phase: 'lock',
          settlementChannel: 'cotsel_escrow',
          displayCurrency: 'USD',
          displayAmount: 1000,
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(403);
      expect(payload.error.code).toBe('FORBIDDEN');
      expect(payload.error.details.reason).toBe('settlement_ingress_disabled');
    } finally {
      server.close();
    }
  });

  test('settlement ingress disabled does not block later non-settlement routes', async () => {
    const { server, baseUrl } = await startServer({ settlementIngressEnabled: false });

    try {
      const response = await fetch(`${baseUrl}/after-settlement`);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
    } finally {
      server.close();
    }
  });

  test('service-authenticated handoff and execution event routes return schema-valid responses', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        tradeId: 'TRD-9001',
        phase: 'stage_1',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
        assetSymbol: 'USDC',
        assetAmount: 125000,
        ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        externalReference: 'EXT-9001',
        metadata: { source: 'contract-test' },
      };

      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-1',
          'X-Request-Id': 'req-handoff-1',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();

      expect(handoffResponse.status).toBe(202);
      expect(validateHandoffResponse(handoffPayload)).toBe(true);

      const handoffId = handoffPayload.data.handoffId as string;
      const eventBody = {
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        providerStatus: 'dispatch_received',
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        detail: 'Dispatch accepted by settlement engine.',
        metadata: { queue: 'primary' },
        observedAt: '2026-03-11T12:00:00.000Z',
      };
      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;

      const eventResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'event-1',
            'X-Request-Id': 'req-event-1',
            ...withServiceAuth(eventPath, eventBody),
          },
          body: JSON.stringify(eventBody),
        },
      );
      const eventPayload = await eventResponse.json();

      expect(eventResponse.status).toBe(202);
      expect(validateMutationResponse(eventPayload)).toBe(true);
      expect(eventPayload.data.callbackDelivery.status).toBe('disabled');

      const listResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          headers: {
            'X-Request-Id': 'req-events-list',
            ...withServiceAuth(eventPath, null, 'GET'),
          },
        },
      );
      const listPayload = await listResponse.json();

      expect(listResponse.status).toBe(200);
      expect(validateEventListResponse(listPayload)).toBe(true);
      expect(listPayload.data).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  test('settlement service routes bypass earlier operator-auth routers', async () => {
    const { server, baseUrl } = await startServer(
      {},
      {},
      { includeProtectedRouterBeforeSettlement: true },
    );

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-before-auth-router',
        tradeId: 'TRD-before-auth-router',
        phase: 'stage_1',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
      };

      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-before-auth-router',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();

      expect(handoffResponse.status).toBe(202);
      expect(validateHandoffResponse(handoffPayload)).toBe(true);
    } finally {
      server.close();
    }
  });

  test('service-authenticated gasless create-trade execution records receipt-backed confirmed events', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-gasless',
        tradeId: 'TRD-gasless',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 1000,
        assetSymbol: 'USDC',
        assetAmount: 1000,
      };
      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-gasless',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();
      const handoffId = handoffPayload.data.handoffId as string;

      const gaslessBody = buildGaslessCreateTradeBody(handoffId);
      const gaslessPath = '/api/dashboard-gateway/v1/settlement/gasless-executions/create-trade';
      const gaslessResponse = await fetch(`${baseUrl}/settlement/gasless-executions/create-trade`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'gasless-create-trade-1',
          'X-Request-Id': 'req-gasless-create',
          ...withServiceAuth(gaslessPath, gaslessBody),
        },
        body: JSON.stringify(gaslessBody),
      });
      const gaslessPayload = await gaslessResponse.json();

      expect(gaslessResponse.status).toBe(202);
      expect(validateGaslessExecutionResponse(gaslessPayload)).toBe(true);
      expect(gaslessPayload.data.txHash).toBe(
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      );
      expect(gaslessPayload.data.handoff.executionStatus).toBe('confirmed');

      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;
      const listResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          headers: {
            ...withServiceAuth(eventPath, null, 'GET'),
          },
        },
      );
      const listPayload = await listResponse.json();

      expect(listPayload.data.map((event: { eventType: string }) => event.eventType)).toEqual([
        'confirmed',
        'submitted',
        'simulation_completed',
        'queued',
        'accepted',
      ]);
      expect(listPayload.data[0].metadata).toEqual(
        expect.objectContaining({
          action: 'create_trade',
          gasUsed: '210000',
          effectiveGasPriceWei: '1000000000',
          nativeCostWei: '210000000000000',
          executorBalanceWei: '1000000000000000000',
          executorAddress: '0x1111111111111111111111111111111111111111',
          chainId: config.chainId,
          contractAddress: config.escrowAddress,
          buyerAddress: gaslessBody.buyerAddress,
          supplierAddress: gaslessBody.supplierAddress,
          totalAmount: gaslessBody.totalAmount,
          logisticsAmount: gaslessBody.logisticsAmount,
          platformFeesAmount: gaslessBody.platformFeesAmount,
          supplierFirstTranche: gaslessBody.supplierFirstTranche,
          supplierSecondTranche: gaslessBody.supplierSecondTranche,
          ricardianHash: gaslessBody.ricardianHash,
          payloadHash: gaslessBody.payloadHash,
        }),
      );
    } finally {
      server.close();
    }
  });

  test('service-authenticated gasless user-action execution records receipt-backed confirmed events', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-user-action',
        tradeId: 'TRD-user-action',
        phase: 'dispute',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 1000,
        assetSymbol: 'USDC',
        assetAmount: 1000,
      };
      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-user-action',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();
      const handoffId = handoffPayload.data.handoffId as string;

      const gaslessBody = buildGaslessUserActionBody(handoffId);
      const gaslessPath = '/api/dashboard-gateway/v1/settlement/gasless-executions/user-action';
      const gaslessResponse = await fetch(`${baseUrl}/settlement/gasless-executions/user-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'gasless-user-action-1',
          'X-Request-Id': 'req-gasless-user-action',
          ...withServiceAuth(gaslessPath, gaslessBody),
        },
        body: JSON.stringify(gaslessBody),
      });
      const gaslessPayload = await gaslessResponse.json();

      expect(gaslessResponse.status).toBe(202);
      expect(validateGaslessUserActionResponse(gaslessPayload)).toBe(true);
      expect(gaslessPayload.data.txHash).toBe(
        '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      );
      expect(gaslessPayload.data.handoff.executionStatus).toBe('confirmed');

      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;
      const listResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          headers: {
            ...withServiceAuth(eventPath, null, 'GET'),
          },
        },
      );
      const listPayload = await listResponse.json();

      expect(listPayload.data.map((event: { eventType: string }) => event.eventType)).toEqual([
        'confirmed',
        'submitted',
        'simulation_completed',
        'queued',
        'accepted',
      ]);
      expect(listPayload.data[0].metadata).toEqual(
        expect.objectContaining({
          action: 'open_dispute',
          gasUsed: '210000',
          effectiveGasPriceWei: '1000000000',
          nativeCostWei: '210000000000000',
          executorBalanceWei: '1000000000000000000',
          executorAddress: '0x1111111111111111111111111111111111111111',
          chainId: config.chainId,
          contractAddress: config.escrowAddress,
          userAddress: gaslessBody.userAddress,
          tradeId: gaslessBody.tradeId,
          payloadHash: gaslessBody.payloadHash,
        }),
      );
    } finally {
      server.close();
    }
  });

  test('gasless create-trade rejects expired, mismatched, and tampered execution envelopes', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-gasless-reject',
        tradeId: 'TRD-gasless-reject',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 1000,
      };
      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-gasless-reject',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();
      const handoffId = handoffPayload.data.handoffId as string;
      const gaslessPath = '/api/dashboard-gateway/v1/settlement/gasless-executions/create-trade';
      const pastEpoch = (Math.floor(Date.now() / 1000) - 60).toString();
      const futureEpoch = (Math.floor(Date.now() / 1000) + 60).toString();

      for (const [label, body, expectedMessage] of [
        [
          'expired',
          buildGaslessCreateTradeBody(handoffId, {
            expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
          }),
          'expired',
        ],
        [
          'wrong-chain',
          buildGaslessCreateTradeBody(handoffId, { chainId: 999 }),
          'chainId does not match',
        ],
        [
          'wrong-contract',
          buildGaslessCreateTradeBody(handoffId, {
            contractAddress: '0x0000000000000000000000000000000000000123',
          }),
          'contractAddress is not allowlisted',
        ],
        [
          'tampered-hash',
          {
            ...buildGaslessCreateTradeBody(handoffId),
            payloadHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
          'payloadHash does not match',
        ],
        [
          'buyer-usdc-mismatch',
          buildGaslessCreateTradeBody(handoffId, {
            buyerAddress: '0x0000000000000000000000000000000000000222',
          }),
          'buyerAddress must match',
        ],
        [
          'usdc-destination-mismatch',
          {
            ...buildGaslessCreateTradeBody(handoffId),
            usdcAuthorization: {
              ...(buildGaslessCreateTradeBody(handoffId).usdcAuthorization as Record<
                string,
                unknown
              >),
              to: '0x0000000000000000000000000000000000000123',
            },
          },
          'usdcAuthorization.to must match',
        ],
        [
          'amount-breakdown-mismatch',
          buildGaslessCreateTradeBody(handoffId, { supplierSecondTranche: '1' }),
          'totalAmount must match settlement amount breakdown',
        ],
        [
          'buyer-authorization-expired',
          buildGaslessCreateTradeBody(handoffId, {
            buyerAuthorization: {
              ...(buildGaslessCreateTradeBody(handoffId).buyerAuthorization as Record<
                string,
                unknown
              >),
              deadline: pastEpoch,
            },
          }),
          'buyerAuthorization.deadline has expired',
        ],
        [
          'usdc-authorization-future',
          buildGaslessCreateTradeBody(handoffId, {
            usdcAuthorization: {
              ...(buildGaslessCreateTradeBody(handoffId).usdcAuthorization as Record<
                string,
                unknown
              >),
              validAfter: futureEpoch,
            },
          }),
          'usdcAuthorization.validAfter is in the future',
        ],
        [
          'usdc-authorization-expired',
          buildGaslessCreateTradeBody(handoffId, {
            usdcAuthorization: {
              ...(buildGaslessCreateTradeBody(handoffId).usdcAuthorization as Record<
                string,
                unknown
              >),
              validBefore: pastEpoch,
            },
          }),
          'usdcAuthorization.validBefore has expired',
        ],
      ] as const) {
        const response = await fetch(`${baseUrl}/settlement/gasless-executions/create-trade`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `gasless-create-trade-${label}`,
            ...withServiceAuth(gaslessPath, body),
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json();

        expect(response.status).toBe(400);
        expect(payload.error.code).toBe('VALIDATION_ERROR');
        expect(payload.error.message).toContain(expectedMessage);
      }

      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;
      const listResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          headers: {
            ...withServiceAuth(eventPath, null, 'GET'),
          },
        },
      );
      const listPayload = await listResponse.json();
      expect(listPayload.data).toEqual([]);
    } finally {
      server.close();
    }
  });

  test('gasless create-trade must match handoff ricardian hash before execution telemetry', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-gasless-ricardian',
        tradeId: 'TRD-gasless-ricardian',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 1000,
        ricardianHash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      };
      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-gasless-ricardian',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();
      const handoffId = handoffPayload.data.handoffId as string;
      const gaslessBody = buildGaslessCreateTradeBody(handoffId);
      const gaslessPath = '/api/dashboard-gateway/v1/settlement/gasless-executions/create-trade';

      const response = await fetch(`${baseUrl}/settlement/gasless-executions/create-trade`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'gasless-create-trade-ricardian',
          ...withServiceAuth(gaslessPath, gaslessBody),
        },
        body: JSON.stringify(gaslessBody),
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error.code).toBe('CONFLICT');
      expect(payload.error.message).toContain('ricardianHash does not match');

      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;
      const listResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          headers: {
            ...withServiceAuth(eventPath, null, 'GET'),
          },
        },
      );
      const listPayload = await listResponse.json();
      expect(listPayload.data).toEqual([]);
    } finally {
      server.close();
    }
  });

  test('gasless create-trade records failed telemetry when simulation fails before broadcast', async () => {
    const { server, baseUrl } = await startServer(
      {},
      {
        async simulateCreateTrade() {
          throw new Error('simulation reverted: authorization deadline expired');
        },
      },
    );

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-gasless-sim-fail',
        tradeId: 'TRD-gasless-sim-fail',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 1000,
      };
      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-gasless-sim-fail',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();
      const handoffId = handoffPayload.data.handoffId as string;
      const gaslessBody = buildGaslessCreateTradeBody(handoffId);
      const gaslessPath = '/api/dashboard-gateway/v1/settlement/gasless-executions/create-trade';
      const gaslessResponse = await fetch(`${baseUrl}/settlement/gasless-executions/create-trade`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'gasless-create-trade-sim-fail',
          ...withServiceAuth(gaslessPath, gaslessBody),
        },
        body: JSON.stringify(gaslessBody),
      });
      const gaslessPayload = await gaslessResponse.json();

      expect(gaslessResponse.status).toBe(502);
      expect(gaslessPayload.error.code).toBe('UPSTREAM_UNAVAILABLE');

      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;
      const listResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          headers: {
            ...withServiceAuth(eventPath, null, 'GET'),
          },
        },
      );
      const listPayload = await listResponse.json();

      expect(listPayload.data.map((event: { eventType: string }) => event.eventType)).toEqual([
        'failed',
        'queued',
        'accepted',
      ]);
      expect(listPayload.data[0].detail).toContain('simulation reverted');
    } finally {
      server.close();
    }
  });

  test('submitted execution events reject unsupported payload fields', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-compat',
        tradeId: 'TRD-compat',
        phase: 'stage_1',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
      };

      const handoffResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-compat',
          'X-Request-Id': 'req-handoff-compat',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', handoffBody),
        },
        body: JSON.stringify(handoffBody),
      });
      const handoffPayload = await handoffResponse.json();
      const handoffId = handoffPayload.data.handoffId as string;

      const eventBody = {
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        legacyExecutionRef: 'archived-chain-reference',
        observedAt: '2026-03-11T12:00:00.000Z',
      };
      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;

      const eventResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'event-compat',
            'X-Request-Id': 'req-event-compat',
            ...withServiceAuth(eventPath, eventBody),
          },
          body: JSON.stringify(eventBody),
        },
      );
      const eventPayload = await eventResponse.json();

      expect(eventResponse.status).toBe(400);
      expect(eventPayload.error.code).toBe('VALIDATION_ERROR');
      expect(eventPayload.error.message).toContain('unsupported fields');
      expect(eventPayload.error.details.unsupportedFields).toEqual(['legacyExecutionRef']);
    } finally {
      server.close();
    }
  });

  test('service auth, idempotency, and state machine violations are enforced', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const createBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-2',
        tradeId: 'TRD-9002',
        phase: 'lock',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 5000,
      };

      const createResponse = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-2',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', createBody),
        },
        body: JSON.stringify(createBody),
      });
      const createPayload = await createResponse.json();
      const handoffId = createPayload.data.handoffId as string;

      const unauthenticated = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-missing-auth',
        },
        body: JSON.stringify(createBody),
      });
      expect(unauthenticated.status).toBe(401);

      const conflictingReplay = await fetch(`${baseUrl}/settlement/handoffs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'handoff-2',
          ...withServiceAuth('/api/dashboard-gateway/v1/settlement/handoffs', {
            ...createBody,
            displayAmount: 6000,
          }),
        },
        body: JSON.stringify({
          ...createBody,
          displayAmount: 6000,
        }),
      });
      expect(conflictingReplay.status).toBe(409);

      const invalidTransitionBody = {
        eventType: 'reconciled',
        executionStatus: 'confirmed',
        reconciliationStatus: 'matched',
        observedAt: '2026-03-11T12:30:00.000Z',
      };
      const eventPath = `/api/dashboard-gateway/v1/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`;
      const invalidTransition = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'event-invalid-transition',
            ...withServiceAuth(eventPath, invalidTransitionBody),
          },
          body: JSON.stringify(invalidTransitionBody),
        },
      );

      expect(invalidTransition.status).toBe(409);

      const submitBody = {
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        observedAt: '2026-03-11T12:20:00.000Z',
      };
      const submitResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'event-submitted-before-confirm',
            ...withServiceAuth(eventPath, submitBody),
          },
          body: JSON.stringify(submitBody),
        },
      );
      expect(submitResponse.status).toBe(202);

      const confirmBody = {
        eventType: 'confirmed',
        executionStatus: 'confirmed',
        reconciliationStatus: 'pending',
        observedAt: '2026-03-11T12:20:30.000Z',
      };
      const confirmResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'event-confirmed',
            ...withServiceAuth(eventPath, confirmBody),
          },
          body: JSON.stringify(confirmBody),
        },
      );
      expect(confirmResponse.status).toBe(202);

      const staleReconcileBody = {
        eventType: 'reconciled',
        executionStatus: 'failed',
        reconciliationStatus: 'matched',
        observedAt: '2026-03-11T12:31:00.000Z',
      };
      const staleReconcileResponse = await fetch(
        `${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'event-reconcile-mutates-execution',
            ...withServiceAuth(eventPath, staleReconcileBody),
          },
          body: JSON.stringify(staleReconcileBody),
        },
      );

      expect(staleReconcileResponse.status).toBe(409);
    } finally {
      server.close();
    }
  });
});
