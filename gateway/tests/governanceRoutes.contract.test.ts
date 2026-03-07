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
import {
  createInMemoryGovernanceActionStore,
  GovernanceActionRecord,
} from '../src/core/governanceStore';
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
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: false,
  writeAllowlist: [],
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
};

const seededActions: GovernanceActionRecord[] = [
  {
    actionId: 'gov-002',
    proposalId: 7,
    category: 'oracle_update',
    status: 'pending_approvals',
    contractMethod: 'proposeOracleUpdate',
    txHash: null,
    extrinsicHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000044',
    createdAt: '2026-03-07T10:10:00.000Z',
    executedAt: null,
    requestId: 'req-2',
    correlationId: 'corr-2',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Rotate oracle after emergency disable.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-2' }],
      ticketRef: 'AGRO-2',
      actorSessionId: 'sess-2',
      actorWallet: '0x00000000000000000000000000000000000000b2',
      actorRole: 'admin',
      createdAt: '2026-03-07T10:10:00.000Z',
      requestedBy: 'uid-admin-2',
      approvedBy: ['uid-admin-1'],
    },
  },
  {
    actionId: 'gov-001',
    proposalId: null,
    category: 'pause',
    status: 'executed',
    contractMethod: 'pause',
    txHash: '0xabc',
    extrinsicHash: null,
    blockNumber: 17,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    createdAt: '2026-03-07T10:00:00.000Z',
    executedAt: '2026-03-07T10:01:00.000Z',
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Pause protocol after treasury drift was detected.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-1' }],
      ticketRef: 'AGRO-1',
      actorSessionId: 'sess-1',
      actorWallet: '0x00000000000000000000000000000000000000a1',
      actorRole: 'admin',
      createdAt: '2026-03-07T10:00:00.000Z',
      requestedBy: 'uid-admin-1',
    },
  },
];

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
  router.use(createGovernanceRouter({
    authSessionClient,
    config,
    governanceStatusService,
    governanceActionStore: createInMemoryGovernanceActionStore(seededActions),
  }));

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
  const validateStatus = createSchemaValidator(spec, '#/components/schemas/GovernanceStatusResponse');
  const validateList = createSchemaValidator(spec, '#/components/schemas/GovernanceActionListResponse');
  const validateDetail = createSchemaValidator(spec, '#/components/schemas/GovernanceActionResponse');

  test('OpenAPI spec exposes governance read endpoints', () => {
    expect(hasOperation(spec, 'get', '/governance/status')).toBe(true);
    expect(hasOperation(spec, 'get', '/governance/actions')).toBe(true);
    expect(hasOperation(spec, 'get', '/governance/actions/{actionId}')).toBe(true);
  });

  test('GET /governance/status returns a schema-valid governance snapshot', async () => {
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

  test('GET /governance/actions lists governance actions with filters and cursor pagination', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const firstResponse = await fetch(`${baseUrl}/governance/actions?limit=1`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const firstPayload = await firstResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(validateList(firstPayload)).toBe(true);
      expect(firstPayload.data.items).toHaveLength(1);
      expect(firstPayload.data.items[0].actionId).toBe('gov-002');
      expect(firstPayload.data.nextCursor).toBeTruthy();

      const secondResponse = await fetch(`${baseUrl}/governance/actions?status=executed&limit=1&cursor=${encodeURIComponent(firstPayload.data.nextCursor)}`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const secondPayload = await secondResponse.json();

      expect(secondResponse.status).toBe(200);
      expect(secondPayload.data.items[0].actionId).toBe('gov-001');
    } finally {
      server.close();
    }
  });

  test('GET /governance/actions/{actionId} returns detail and 404s when missing', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const detailResponse = await fetch(`${baseUrl}/governance/actions/gov-001`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const detailPayload = await detailResponse.json();

      expect(detailResponse.status).toBe(200);
      expect(validateDetail(detailPayload)).toBe(true);
      expect(detailPayload.data.contractMethod).toBe('pause');

      const missingResponse = await fetch(`${baseUrl}/governance/actions/missing-action`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const missingPayload = await missingResponse.json();

      expect(missingResponse.status).toBe(404);
      expect(missingPayload.error.code).toBe('NOT_FOUND');
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

  test('governance list validates malformed query parameters', async () => {
    const { server, baseUrl } = await startServer('admin');

    try {
      const response = await fetch(`${baseUrl}/governance/actions?limit=999`, {
        headers: { Authorization: 'Bearer sess-admin' },
      });
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe('VALIDATION_ERROR');
    } finally {
      server.close();
    }
  });
});
