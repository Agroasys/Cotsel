/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createGovernanceRouter } from '../src/routes/governance';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { EscrowGovernanceReader } from '../src/core/governanceStatusService';

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
  usdcAddress: '0x0000000000000000000000000000000000000888',
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
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

async function startServer(sessionRole: 'admin' | 'buyer' | null) {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (sessionRole === null) {
        return null;
      }

      return {
        userId: `uid-${sessionRole}`,
        walletAddress: '0x00000000000000000000000000000000000000aa',
        role: sessionRole,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const governanceStatusService: EscrowGovernanceReader = {
    checkReadiness: jest.fn(),
    getGovernanceStatus: jest.fn().mockResolvedValue({
      paused: false,
      claimsPaused: false,
      oracleActive: true,
      oracleAddress: '0x0000000000000000000000000000000000000011',
      treasuryAddress: '0x0000000000000000000000000000000000000022',
      treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
      governanceApprovalsRequired: 2,
      governanceTimelockSeconds: 86400,
      requiredAdminCount: 1,
      hasActiveUnpauseProposal: false,
      activeUnpauseApprovals: 0,
      activeOracleProposalIds: [7],
      activeTreasuryPayoutReceiverProposalIds: [],
    }),
  };

  const router = Router();
  router.use(
    createGovernanceRouter({
      authSessionClient,
      config,
      governanceStatusService,
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
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
  };
}

describe('gateway governance read routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateStatus = createSchemaValidator(
    spec,
    '#/components/schemas/GovernanceStatusResponse',
  );

  test('OpenAPI spec exposes the governance status endpoint', () => {
    expect(hasOperation(spec, 'get', '/governance/status')).toBe(true);
  });

  test('GET /governance/status returns a schema-valid governance snapshot read from chain', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const response = await fetch(`${baseUrl}/governance/status`, {
        headers: {
          Authorization: 'Bearer sess-admin',
          'x-request-id': 'req-governance-status',
        },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('req-governance-status');
      expect(validateStatus(payload)).toBe(true);
      expect(payload.data.activeOracleProposalIds).toEqual([7]);
    } finally {
      server.close();
    }
  });

  test('governance read routes require an authenticated admin session', async () => {
    const unauthenticated = await startServer(null);
    const nonAdmin = await startServer('buyer');

    try {
      const unauthenticatedResponse = await fetch(`${unauthenticated.baseUrl}/governance/status`);
      const unauthenticatedPayload = await unauthenticatedResponse.json();

      expect(unauthenticatedResponse.status).toBe(401);
      expect(unauthenticatedPayload.error.code).toBe('AUTH_REQUIRED');

      const forbiddenResponse = await fetch(`${nonAdmin.baseUrl}/governance/status`, {
        headers: { Authorization: 'Bearer sess-buyer' },
      });
      const forbiddenPayload = await forbiddenResponse.json();

      expect(forbiddenResponse.status).toBe(403);
      expect(forbiddenPayload.error.code).toBe('FORBIDDEN');
    } finally {
      unauthenticated.server.close();
      nonAdmin.server.close();
    }
  });
});
