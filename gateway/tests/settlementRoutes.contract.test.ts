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
  escrowAddress: '0x0000000000000000000000000000000000000000',
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
  commitSha: 'abc1234',
  buildTime: '2026-03-11T00:00:00.000Z',
  nodeEnv: 'test',
};

async function startServer(overrides: Partial<GatewayConfig> = {}) {
  const runtimeConfig: GatewayConfig = { ...config, ...overrides };
  const settlementStore = createInMemorySettlementStore();
  const settlementService = new SettlementService(runtimeConfig, settlementStore);
  const nonceStore = createInMemoryNonceStore();
  const idempotencyStore = createInMemoryIdempotencyStore();
  const router = Router();
  router.use(createSettlementRouter({
    config: runtimeConfig,
    settlementService,
    settlementStore,
    nonceStore,
    idempotencyStore,
    lookupServiceApiKey: createServiceApiKeyLookup(runtimeConfig.settlementServiceAuthApiKeysJson),
  }));

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

describe('gateway settlement routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateHandoffResponse = createSchemaValidator(spec, '#/components/schemas/SettlementHandoffResponse');
  const validateMutationResponse = createSchemaValidator(spec, '#/components/schemas/SettlementExecutionEventMutationResponse');
  const validateEventListResponse = createSchemaValidator(spec, '#/components/schemas/SettlementExecutionEventListResponse');

  test('OpenAPI spec exposes settlement ingress routes', () => {
    expect(hasOperation(spec, 'post', '/settlement/handoffs')).toBe(true);
    expect(hasOperation(spec, 'post', '/settlement/handoffs/{handoffId}/execution-events')).toBe(true);
    expect(hasOperation(spec, 'get', '/settlement/handoffs/{handoffId}/execution-events')).toBe(true);
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
          settlementChannel: 'web3layer_escrow',
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

  test('service-authenticated handoff and execution event routes return schema-valid responses', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const handoffBody = {
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        tradeId: 'TRD-9001',
        phase: 'stage_1',
        settlementChannel: 'web3layer_escrow',
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

      const eventResponse = await fetch(`${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'event-1',
          'X-Request-Id': 'req-event-1',
          ...withServiceAuth(eventPath, eventBody),
        },
        body: JSON.stringify(eventBody),
      });
      const eventPayload = await eventResponse.json();

      expect(eventResponse.status).toBe(202);
      expect(validateMutationResponse(eventPayload)).toBe(true);
      expect(eventPayload.data.callbackDelivery.status).toBe('disabled');

      const listResponse = await fetch(`${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`, {
        headers: {
          'X-Request-Id': 'req-events-list',
          ...withServiceAuth(eventPath, null, 'GET'),
        },
      });
      const listPayload = await listResponse.json();

      expect(listResponse.status).toBe(200);
      expect(validateEventListResponse(listPayload)).toBe(true);
      expect(listPayload.data).toHaveLength(1);
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
        settlementChannel: 'web3layer_escrow',
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
      const invalidTransition = await fetch(`${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'event-invalid-transition',
          ...withServiceAuth(eventPath, invalidTransitionBody),
        },
        body: JSON.stringify(invalidTransitionBody),
      });

      expect(invalidTransition.status).toBe(409);

      const submitBody = {
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        observedAt: '2026-03-11T12:20:00.000Z',
      };
      const submitResponse = await fetch(`${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'event-submitted-before-confirm',
          ...withServiceAuth(eventPath, submitBody),
        },
        body: JSON.stringify(submitBody),
      });
      expect(submitResponse.status).toBe(202);

      const confirmBody = {
        eventType: 'confirmed',
        executionStatus: 'confirmed',
        reconciliationStatus: 'pending',
        observedAt: '2026-03-11T12:20:30.000Z',
      };
      const confirmResponse = await fetch(`${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'event-confirmed',
          ...withServiceAuth(eventPath, confirmBody),
        },
        body: JSON.stringify(confirmBody),
      });
      expect(confirmResponse.status).toBe(202);

      const staleReconcileBody = {
        eventType: 'reconciled',
        executionStatus: 'failed',
        reconciliationStatus: 'matched',
        observedAt: '2026-03-11T12:31:00.000Z',
      };
      const staleReconcileResponse = await fetch(`${baseUrl}/settlement/handoffs/${encodeURIComponent(handoffId)}/execution-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'event-reconcile-mutates-execution',
          ...withServiceAuth(eventPath, staleReconcileBody),
        },
        body: JSON.stringify(staleReconcileBody),
      });

      expect(staleReconcileResponse.status).toBe(409);
    } finally {
      server.close();
    }
  });
});
