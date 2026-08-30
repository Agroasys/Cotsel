/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { GaslessSettlementExecutionService } from '../src/core/gaslessSettlementExecutionService';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import type { OperationsSummaryReader } from '../src/core/operationsSummaryService';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createOperationsRouter } from '../src/routes/operations';

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
  chainId: 84532,
  escrowAddress: '0x0000000000000000000000000000000000000001',
  usdcAddress: '0x0000000000000000000000000000000000000002',
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
  buildTime: '2026-08-29T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  contractAddressRequired: true,
  allowInsecureDownstreamAuth: true,
};

async function startServer(
  gaslessSettlementService: GaslessSettlementExecutionService,
  capabilities: string[] = ['operations:replay'],
) {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockResolvedValue({
      userId: 'uid-admin',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      role: 'admin',
      capabilities,
      signerAuthorizations: [],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }),
    checkReadiness: jest.fn(),
  };
  const operationsSummaryService = {
    getOperationsSummary: jest.fn(),
  } as unknown as OperationsSummaryReader;
  const router = Router();
  router.use(
    createOperationsRouter({
      authSessionClient,
      config,
      operationsSummaryService,
      gaslessSettlementService,
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
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve server address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1` };
}

describe('gasless command operations route contract', () => {
  const spec = loadOpenApiSpec();
  const validateDeadLetters = createSchemaValidator(
    spec,
    '#/components/schemas/GaslessCommandDeadLetterListResponse',
  );
  const validateRedrive = createSchemaValidator(
    spec,
    '#/components/schemas/GaslessCommandRedriveResponse',
  );
  const validateReadiness = createSchemaValidator(
    spec,
    '#/components/schemas/GaslessRelayerReadinessResponse',
  );

  test('returns the durable queue control-plane posture', async () => {
    const gaslessSettlementService = {
      getRelayerReadiness: jest.fn().mockReturnValue({
        enabled: true,
        paused: true,
        state: 'paused',
        generatedAt: '2026-08-29T00:00:00.000Z',
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
          receiptTimeoutMs: 120000,
          repeatedFailureAlertThreshold: 3,
        },
        capacityPolicy: {
          targetTransactionsPerDay: 500,
          averageTransactionsPerHour: 21,
          burstTransactionsPerHour: 84,
          burstMultiplierBasisPoints: 40000,
          safetyMarginBasisPoints: 12500,
          maxCostPerTxWei: '75000000000000000',
          requiredBurstHourBalanceWei: '7875000000000000000',
          configuredMinExecutorBalanceWei: '10000000000000000',
          configuredLowBalanceAlertWei: '5000000000000000',
          floorMeetsPolicy: false,
          lowBalanceAlertProtectsPolicy: false,
          failClosed: false,
        },
        executorBalanceWei: '4000000000000000',
        queue: {
          pending: 0,
          active: 0,
          awaitingOutcome: 0,
          deadLetter: 0,
          expiredLeases: 0,
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
    const { server, baseUrl } = await startServer(gaslessSettlementService);

    try {
      const response = await fetch(`${baseUrl}/operations/gasless-relayer/readiness`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(validateReadiness(payload)).toBe(true);
      expect(payload.data).toMatchObject({
        state: 'paused',
        executorBalanceWei: '4000000000000000',
        queue: { awaitingOutcome: 0, deadLetter: 0, expiredLeases: 0 },
      });
      expect(payload.data.capacityPolicy.requiredBurstHourBalanceWei).toBe('7875000000000000000');
    } finally {
      server.close();
    }
  });

  test('lists redacted dead letters and authorizes one idempotent redrive', async () => {
    expect(hasOperation(spec, 'get', '/operations/gasless-relayer/dead-letters')).toBe(true);
    expect(
      hasOperation(spec, 'post', '/operations/gasless-relayer/dead-letters/{commandId}/redrive'),
    ).toBe(true);
    const commandId = '11111111-1111-4111-8111-111111111111';
    const deadLetter = {
      commandId,
      applicationRequestId: 'request-dead-letter-1',
      intentKey: 'a'.repeat(64),
      resourceType: 'settlement_handoff',
      resourceId: 'handoff-dead-letter-1',
      operation: 'create_trade',
      maxAttempts: 5,
      nextAttemptAt: '2026-08-29T00:00:00.000Z',
      status: 'dead_letter',
      attemptCount: 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      transactionHash: null,
      lastErrorCode: 'LEASE_ATTEMPTS_EXHAUSTED',
      lastErrorDetail: 'Worker lease expired after the maximum attempt count',
      completedAt: '2026-08-29T00:01:00.000Z',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
    };
    const gaslessSettlementService = {
      listDeadLetterCommands: jest.fn().mockResolvedValue([deadLetter]),
      redriveDeadLetterCommand: jest.fn().mockResolvedValue({
        ...deadLetter,
        status: 'pending',
        maxAttempts: 6,
        lastErrorCode: null,
        lastErrorDetail: null,
        completedAt: null,
        payload: { financialData: 'must-not-be-returned' },
        result: { internalResult: 'must-not-be-returned' },
      }),
    } as unknown as GaslessSettlementExecutionService;
    const { server, baseUrl } = await startServer(gaslessSettlementService);

    try {
      const listResponse = await fetch(
        `${baseUrl}/operations/gasless-relayer/dead-letters?limit=25`,
        {
          headers: { Authorization: 'Bearer sess-admin' },
        },
      );
      const listPayload = await listResponse.json();
      expect(listResponse.status).toBe(200);
      expect(validateDeadLetters(listPayload)).toBe(true);
      expect(gaslessSettlementService.listDeadLetterCommands).toHaveBeenCalledWith(25);
      expect(listPayload.data.items[0]).not.toHaveProperty('payload');
      expect(listPayload.data.items[0]).not.toHaveProperty('result');

      const redriveResponse = await fetch(
        `${baseUrl}/operations/gasless-relayer/dead-letters/${commandId}/redrive`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sess-admin',
            'Idempotency-Key': 'gasless-redrive-1',
          },
        },
      );
      const redrivePayload = await redriveResponse.json();
      expect(redriveResponse.status).toBe(202);
      expect(validateRedrive(redrivePayload)).toBe(true);
      expect(gaslessSettlementService.redriveDeadLetterCommand).toHaveBeenCalledWith(
        commandId,
        expect.objectContaining({
          route: '/operations/gasless-relayer/dead-letters/:commandId/redrive',
          method: 'POST',
          idempotencyKey: 'gasless-redrive-1',
          requestContext: expect.objectContaining({
            requestId: expect.any(String),
            correlationId: expect.any(String),
          }),
          principal: expect.objectContaining({
            session: expect.objectContaining({ userId: 'uid-admin', role: 'admin' }),
          }),
        }),
      );
      expect(redrivePayload.data).not.toHaveProperty('payload');
      expect(redrivePayload.data).not.toHaveProperty('result');
    } finally {
      server.close();
    }
  });

  test('rejects redrive without the replay capability', async () => {
    const gaslessSettlementService = {
      redriveDeadLetterCommand: jest.fn(),
    } as unknown as GaslessSettlementExecutionService;
    const { server, baseUrl } = await startServer(gaslessSettlementService, []);

    try {
      const response = await fetch(
        `${baseUrl}/operations/gasless-relayer/dead-letters/11111111-1111-4111-8111-111111111111/redrive`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sess-admin',
            'Idempotency-Key': 'unauthorized-gasless-redrive',
          },
        },
      );
      expect(response.status).toBe(403);
      expect(gaslessSettlementService.redriveDeadLetterCommand).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  test('rejects an invalid dead-letter limit before querying the store', async () => {
    const gaslessSettlementService = {
      listDeadLetterCommands: jest.fn(),
    } as unknown as GaslessSettlementExecutionService;
    const { server, baseUrl } = await startServer(gaslessSettlementService);

    try {
      const response = await fetch(`${baseUrl}/operations/gasless-relayer/dead-letters?limit=101`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      expect(response.status).toBe(400);
      expect(gaslessSettlementService.listDeadLetterCommands).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
