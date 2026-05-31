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
import type { GaslessSettlementExecutionService } from '../src/core/gaslessSettlementExecutionService';
import type { GatewayFailedOperationReplayer } from '../src/core/errorHandlerWorkflow';
import type {
  OperationsSummaryReader,
  OperationsSummarySnapshot,
} from '../src/core/operationsSummaryService';
import type { FailedOperationRecord, FailedOperationStore } from '../src/core/failedOperationStore';
import type { IdempotencyStore } from '../src/core/idempotencyStore';

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
  gaslessSettlementService?: GaslessSettlementExecutionService | null,
  failedOperationStore?: FailedOperationStore | null,
  failedOperationReplayer?: GatewayFailedOperationReplayer | null,
  idempotencyStore?: IdempotencyStore | null,
  routeConfig: GatewayConfig = config,
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
  router.use(
    createOperationsRouter({
      authSessionClient,
      config: routeConfig,
      operationsSummaryService,
      gaslessSettlementService,
      failedOperationStore,
      failedOperationReplayer,
      idempotencyStore,
    }),
  );

  const app = createApp(routeConfig, {
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
  const validateGaslessRelayerReadiness = createSchemaValidator(
    spec,
    '#/components/schemas/GaslessRelayerReadinessResponse',
  );

  test('OpenAPI spec exposes operations read endpoints', () => {
    expect(hasOperation(spec, 'get', '/operations')).toBe(true);
    expect(hasOperation(spec, 'get', '/operations/summary')).toBe(true);
    expect(hasOperation(spec, 'get', '/operations/gasless-relayer/readiness')).toBe(true);
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

  test('GET /operations/gasless-relayer/readiness returns gasless control-plane posture', async () => {
    const gaslessSettlementService = {
      getRelayerReadiness: jest.fn().mockReturnValue({
        enabled: true,
        paused: true,
        state: 'paused',
        generatedAt: '2026-03-12T00:00:00.000Z',
        signerCustodyMode: 'raw_private_key',
        activeExecutionPath: {
          chainId: 84532,
          escrowAddress: '0x0000000000000000000000000000000000000999',
          rpcFallbackCount: 1,
        },
        controls: {
          gasLimitCap: '1500000',
          maxFeePerGasWei: '50000000000',
          maxNativeCostWei: '100000000000000000',
          minExecutorBalanceWei: '10000000000000000',
          lowBalanceAlertWei: '5000000000000000',
          stuckQueueThresholdMs: 300000,
          repeatedFailureAlertThreshold: 3,
        },
        executorBalanceWei: '4000000000000000',
        queue: {
          pending: 0,
          active: 0,
          lastQueueWaitMs: null,
          lastSubmissionAt: null,
        },
        alerts: [
          {
            code: 'gasless_broadcast_paused',
            severity: 'high',
            detail: 'Gasless relayer broadcasts are paused by operator configuration.',
          },
          {
            code: 'gasless_low_executor_balance',
            severity: 'critical',
            detail:
              'Gasless executor balance is at or below the configured low-balance alert threshold.',
          },
        ],
        recentFailureCount: 0,
      }),
    } as unknown as GaslessSettlementExecutionService;
    const { server, baseUrl } = await startServer(
      'admin',
      operationsFixture,
      gaslessSettlementService,
    );

    try {
      const response = await fetch(`${baseUrl}/operations/gasless-relayer/readiness`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateGaslessRelayerReadiness(payload)).toBe(true);
      expect(payload.data.state).toBe('paused');
      expect(payload.data.executorBalanceWei).toBe('4000000000000000');
      expect(payload.data.controls.maxFeePerGasWei).toBe('50000000000');
      expect(payload.data.alerts[0].code).toBe('gasless_broadcast_paused');
      expect(payload.data.alerts[1].code).toBe('gasless_low_executor_balance');
    } finally {
      server.close();
    }
  });

  test('GET /operations/failed-operations returns sanitized replay queue records', async () => {
    const failedRecord: FailedOperationRecord = {
      failedOperationId: 'failed-op-1',
      operationType: 'settlement-callback',
      operationKey: 'callback-1',
      targetService: 'agroasys-backend',
      route: '/settlement/callbacks',
      method: 'POST',
      payloadHash: 'hash-1',
      requestPayload: { secret: 'redacted-by-route' },
      requestId: 'req-failed-1',
      correlationId: null,
      idempotencyKey: 'idem-1',
      actionKey: null,
      actorId: null,
      actorUserId: 'admin-1',
      actorWalletAddress: null,
      actorRole: 'admin',
      sessionReference: 'session-1',
      replayEligible: true,
      failureState: 'open',
      firstFailedAt: '2026-03-12T00:00:00.000Z',
      lastFailedAt: '2026-03-12T00:05:00.000Z',
      retryCount: 3,
      terminalErrorClass: 'infrastructure',
      terminalErrorCode: 'CALLBACK_503',
      terminalErrorMessage: 'Callback service unavailable',
      metadata: { source: 'test' },
      lastReplayedAt: null,
      createdAt: '2026-03-12T00:00:00.000Z',
      updatedAt: '2026-03-12T00:05:00.000Z',
    };
    const failedOperationStore = {
      list: jest.fn().mockResolvedValue([failedRecord]),
      get: jest.fn(),
      recordFailure: jest.fn(),
      markReplayed: jest.fn(),
      markReplayFailed: jest.fn(),
    } as unknown as FailedOperationStore;
    const { server, baseUrl } = await startServer(
      'admin',
      operationsFixture,
      null,
      failedOperationStore,
    );

    try {
      const response = await fetch(
        `${baseUrl}/operations/failed-operations?failureState=open&replayEligible=true`,
        { headers: { Authorization: 'Bearer sess-admin' } },
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(failedOperationStore.list).toHaveBeenCalledWith({
        failureState: 'open',
        replayEligible: true,
      });
      expect(payload.data.items).toHaveLength(1);
      expect(payload.data.items[0]).toEqual(
        expect.objectContaining({
          failedOperationId: 'failed-op-1',
          replayEligible: true,
          failureState: 'open',
          requestPayload: null,
        }),
      );
    } finally {
      server.close();
    }
  });

  test('POST /operations/failed-operations/:id/replay requires idempotency before replaying', async () => {
    const replayedRecord: FailedOperationRecord = {
      failedOperationId: 'failed-op-1',
      operationType: 'settlement-callback',
      operationKey: 'callback-1',
      targetService: 'agroasys-backend',
      route: '/settlement/callbacks',
      method: 'POST',
      payloadHash: 'hash-1',
      requestPayload: { callback: true },
      requestId: 'req-failed-1',
      correlationId: null,
      idempotencyKey: 'idem-1',
      actionKey: null,
      actorId: null,
      actorUserId: 'admin-1',
      actorWalletAddress: null,
      actorRole: 'admin',
      sessionReference: 'session-1',
      replayEligible: true,
      failureState: 'replayed',
      firstFailedAt: '2026-03-12T00:00:00.000Z',
      lastFailedAt: '2026-03-12T00:05:00.000Z',
      retryCount: 3,
      terminalErrorClass: 'infrastructure',
      terminalErrorCode: 'CALLBACK_503',
      terminalErrorMessage: 'Callback service unavailable',
      metadata: { replayed: true },
      lastReplayedAt: '2026-03-12T00:10:00.000Z',
      createdAt: '2026-03-12T00:00:00.000Z',
      updatedAt: '2026-03-12T00:10:00.000Z',
    };
    const failedOperationStore = {
      list: jest.fn(),
      get: jest.fn(),
      recordFailure: jest.fn(),
      markReplayed: jest.fn(),
      markReplayFailed: jest.fn(),
    } as unknown as FailedOperationStore;
    const failedOperationReplayer = {
      replay: jest.fn().mockResolvedValue(replayedRecord),
    } as unknown as GatewayFailedOperationReplayer;
    const idempotencyStore = {
      get: jest.fn(),
      createPending: jest.fn().mockResolvedValue({
        created: true,
        record: {
          idempotencyKey: 'replay-1',
          actorId: 'user:uid-admin',
          endpoint: '/operations/failed-operations/:failedOperationId/replay',
          requestMethod: 'POST',
          requestPath: '/api/dashboard-gateway/v1/operations/failed-operations/failed-op-1/replay',
          requestFingerprint: 'hash',
          requestId: 'req-replay-1',
          responseStatus: null,
          responseHeaders: {},
          responseBody: null,
          completedAt: null,
          createdAt: '2026-03-12T00:00:00.000Z',
        },
      }),
      complete: jest.fn().mockResolvedValue(undefined),
      releasePending: jest.fn().mockResolvedValue(undefined),
      markReplay: jest.fn().mockResolvedValue(undefined),
    } as unknown as IdempotencyStore;
    const writeConfig = {
      ...config,
      enableMutations: true,
      writeAllowlist: ['uid-admin'],
    };
    const { server, baseUrl } = await startServer(
      'admin',
      operationsFixture,
      null,
      failedOperationStore,
      failedOperationReplayer,
      idempotencyStore,
      writeConfig,
    );

    try {
      const response = await fetch(`${baseUrl}/operations/failed-operations/failed-op-1/replay`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'Idempotency-Key': 'replay-1',
        },
      });
      const payload = await response.json();

      expect(response.status).toBe(202);
      expect(idempotencyStore.createPending).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'replay-1',
          actorId: 'user:uid-admin',
          requestMethod: 'POST',
        }),
      );
      expect(failedOperationReplayer.replay).toHaveBeenCalledWith('failed-op-1');
      expect(payload.data).toEqual(
        expect.objectContaining({
          failedOperationId: 'failed-op-1',
          failureState: 'replayed',
          requestPayload: null,
        }),
      );
    } finally {
      server.close();
    }
  });
});
