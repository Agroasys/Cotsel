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
import type { AuthSessionClient, SignerAuthorization } from '../src/core/authSessionClient';
import type { GovernanceMutationPreflightReader } from '../src/core/governanceStatusService';
import { createInMemoryGovernanceActionStore } from '../src/core/governanceInMemoryStore';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';
import { GovernanceMutationService } from '../src/core/governanceMutationService';
import type { GovernanceTransactionVerifier } from '../src/core/governanceMutationTypes';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';

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
  operatorSignerEnvironment: 'staging',
  enableMutations: true,
  writeAllowlist: ['acct-admin'],
  governancePreparationTtlSeconds: 86400,
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
  contractAddressRequired: true,
  allowInsecureDownstreamAuth: true,
};

async function startServer(
  sessionRole: 'admin' | 'buyer' | null,
  signerAuthorizations: SignerAuthorization[] = [],
) {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (sessionRole === null) {
        return null;
      }

      return {
        userId: `uid-${sessionRole}`,
        accountId: `acct-${sessionRole}`,
        walletAddress: '0x00000000000000000000000000000000000000aa',
        role: sessionRole,
        capabilities: sessionRole === 'admin' ? ['governance:write'] : [],
        signerAuthorizations,
        breakGlass: {
          active: false,
          role: null,
          expiresAt: null,
          grantedAt: null,
          grantedBy: null,
          reason: null,
          revokedAt: null,
          revokedBy: null,
          reviewedAt: null,
          reviewedBy: null,
          reviewStatus: 'none',
        },
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const governanceStatusService: GovernanceMutationPreflightReader = {
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
    getUnpauseProposalState: jest.fn(),
    getOracleProposalState: jest.fn(),
    getTreasuryPayoutReceiverProposalState: jest.fn(),
    getTreasuryClaimableBalance: jest.fn(),
    hasApprovedUnpause: jest.fn(),
    hasApprovedOracleProposal: jest.fn(),
    hasApprovedTreasuryPayoutReceiverProposal: jest.fn(),
  };

  const governanceActionStore = createInMemoryGovernanceActionStore();
  const governanceWriteStore = createPassthroughGovernanceWriteStore(
    governanceActionStore,
    createInMemoryAuditLogStore(),
  );
  const verifier: GovernanceTransactionVerifier = {
    getTransactionCount: jest.fn(async () => 0),
    getTransaction: jest.fn(async () => null),
    getTransactionReceipt: jest.fn(async () => null),
    getBlockNumber: jest.fn(async () => null),
  };

  const router = Router();
  router.use(
    createGovernanceRouter({
      authSessionClient,
      config,
      governanceStatusService,
      governanceActionStore,
      governanceMutationService: new GovernanceMutationService(
        config,
        governanceActionStore,
        governanceWriteStore,
        verifier,
      ),
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
  const validatePrepared = createSchemaValidator(
    spec,
    '#/components/schemas/GovernanceActionPreparedResponse',
  );

  test('OpenAPI spec exposes the governance status endpoint', () => {
    expect(hasOperation(spec, 'get', '/governance/status')).toBe(true);
    expect(hasOperation(spec, 'post', '/governance/pause/prepare')).toBe(true);
    expect(hasOperation(spec, 'post', '/governance/actions/{actionId}/confirm')).toBe(true);
    expect(hasOperation(spec, 'post', '/governance/pause')).toBe(false);
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

  test('an admin session receives no governance signer authority without an exact register entry', async () => {
    const { server, baseUrl } = await startServer('admin');
    try {
      const response = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'governance-unregistered-wallet',
        },
        body: JSON.stringify({
          signerWallet: '0x00000000000000000000000000000000000000aa',
          audit: {
            reason: 'Attempt with no explicit signer register entry.',
            ticketRef: 'WP1-641',
            evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/WP1-641' }],
          },
        }),
      });
      const payload = await response.json();
      expect(response.status).toBe(403);
      expect(payload.error.code).toBe('SIGNER_NOT_AUTHORIZED');
    } finally {
      server.close();
    }
  });

  test('a wildcard signer environment is rejected instead of authorizing every deployment', async () => {
    const { server, baseUrl } = await startServer('admin', [
      {
        bindingId: 'legacy-wildcard',
        walletAddress: '0x00000000000000000000000000000000000000aa',
        actionClass: 'governance',
        environment: '*',
        approvedAt: '2026-09-11T08:00:00.000Z',
        approvedBy: 'legacy-admin-role',
        ticketRef: null,
        notes: null,
      },
    ]);
    try {
      const response = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'governance-wildcard-wallet',
        },
        body: JSON.stringify({
          signerWallet: '0x00000000000000000000000000000000000000aa',
          audit: {
            reason: 'Attempt with a retired wildcard signer grant.',
            ticketRef: 'WP1-641',
            evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/WP1-641' }],
          },
        }),
      });
      const payload = await response.json();
      expect(response.status).toBe(403);
      expect(payload.error.code).toBe('SIGNER_NOT_AUTHORIZED');
    } finally {
      server.close();
    }
  });

  test('an exact active register entry returns an action-bound unsigned transaction', async () => {
    const { server, baseUrl } = await startServer('admin', [
      {
        bindingId: 'binding-admin-1',
        walletAddress: '0x00000000000000000000000000000000000000AA',
        actionClass: 'governance',
        environment: 'staging',
        approvedAt: '2026-09-11T08:00:00.000Z',
        approvedBy: 'security-owner',
        ticketRef: 'WP1-641',
        notes: null,
      },
    ]);
    try {
      const response = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'governance-exact-wallet',
        },
        body: JSON.stringify({
          signerWallet: '0x00000000000000000000000000000000000000AA',
          audit: {
            reason: 'Prepare with exact registered hardware-wallet authority.',
            ticketRef: 'WP1-641',
            evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/WP1-641' }],
          },
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validatePrepared(payload)).toBe(true);
      expect(payload.data.signing).toMatchObject({
        actionId: payload.data.actionId,
        intentKey: payload.data.intentKey,
        actionType: 'pause',
        auditReference: 'WP1-641',
        chainId: 31337,
        signerWallet: '0x00000000000000000000000000000000000000AA',
        txRequest: {
          chainId: 31337,
          from: '0x00000000000000000000000000000000000000AA',
          value: '0',
          nonce: 0,
        },
      });
    } finally {
      server.close();
    }
  });
});
