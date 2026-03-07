/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import {
  createInMemoryGovernanceActionStore,
  GovernanceActionStore,
} from '../src/core/governanceStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import { GovernanceMutationService } from '../src/core/governanceMutationService';
import {
  GovernanceMutationPreflightReader,
  GovernanceProposalState,
  GovernanceStatusSnapshot,
  UnpauseProposalState,
} from '../src/core/governanceStatusService';
import { createAuthenticationMiddleware } from '../src/middleware/auth';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createGovernanceMutationRouter } from '../src/routes/governanceMutations';

const baseConfig: GatewayConfig = {
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
  enableMutations: true,
  writeAllowlist: ['uid-admin'],
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
};

function buildStatusSnapshot(overrides: Partial<GovernanceStatusSnapshot> = {}): GovernanceStatusSnapshot {
  return {
    paused: false,
    claimsPaused: false,
    oracleActive: true,
    oracleAddress: '0x0000000000000000000000000000000000000011',
    treasuryAddress: '0x0000000000000000000000000000000000000022',
    treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
    governanceApprovalsRequired: 2,
    governanceTimelockSeconds: 86400,
    requiredAdminCount: 2,
    hasActiveUnpauseProposal: false,
    activeUnpauseApprovals: 0,
    activeOracleProposalIds: [],
    activeTreasuryPayoutReceiverProposalIds: [],
    ...overrides,
  };
}

function buildProposalState(overrides: Partial<GovernanceProposalState> = {}): GovernanceProposalState {
  return {
    proposalId: 7,
    approvalCount: 1,
    executed: false,
    cancelled: false,
    expired: false,
    etaSeconds: Math.floor(Date.now() / 1000) - 5,
    targetAddress: '0x0000000000000000000000000000000000000044',
    ...overrides,
  };
}

function buildUnpauseProposal(overrides: Partial<UnpauseProposalState> = {}): UnpauseProposalState {
  return {
    hasActiveProposal: true,
    approvalCount: 1,
    executed: false,
    ...overrides,
  };
}

function buildAuditBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    audit: {
      reason: 'Enterprise control action required for controlled governance execution.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-123' }],
      ticketRef: 'AGRO-123',
    },
  };
}

interface StartServerOptions {
  sessionRole?: 'admin' | 'buyer' | null;
  enableMutations?: boolean;
  writeAllowlist?: string[];
  configureReader?: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => void;
}

async function startServer(options: StartServerOptions = {}) {
  const config: GatewayConfig = {
    ...baseConfig,
    enableMutations: options.enableMutations ?? baseConfig.enableMutations,
    writeAllowlist: options.writeAllowlist ?? baseConfig.writeAllowlist,
  };

  const governanceReader: jest.Mocked<GovernanceMutationPreflightReader> = {
    checkReadiness: jest.fn(),
    getGovernanceStatus: jest.fn().mockResolvedValue(buildStatusSnapshot()),
    getUnpauseProposalState: jest.fn().mockResolvedValue(buildUnpauseProposal()),
    getOracleProposalState: jest.fn().mockResolvedValue(buildProposalState()),
    getTreasuryPayoutReceiverProposalState: jest.fn().mockResolvedValue(buildProposalState()),
    getTreasuryClaimableBalance: jest.fn().mockResolvedValue(10n),
    hasApprovedUnpause: jest.fn().mockResolvedValue(false),
    hasApprovedOracleProposal: jest.fn().mockResolvedValue(false),
    hasApprovedTreasuryPayoutReceiverProposal: jest.fn().mockResolvedValue(false),
  };
  options.configureReader?.(governanceReader);

  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async () => {
      if (options.sessionRole === null) {
        return null;
      }

      const role = options.sessionRole ?? 'admin';
      return {
        userId: role === 'admin' ? 'uid-admin' : 'uid-buyer',
        walletAddress: role === 'admin'
          ? '0x00000000000000000000000000000000000000aa'
          : '0x00000000000000000000000000000000000000bb',
        role,
        email: role === 'admin' ? 'admin@agroasys.io' : 'buyer@agroasys.io',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const auditLogStore = createInMemoryAuditLogStore();
  const governanceActionStore = createInMemoryGovernanceActionStore();
  const idempotencyStore = createInMemoryIdempotencyStore();
  const mutationService = new GovernanceMutationService(
    config,
    createPassthroughGovernanceWriteStore(governanceActionStore, auditLogStore),
  );

  const router = Router();
  router.use(createGovernanceMutationRouter({
    authSessionClient,
    config,
    governanceReader,
    mutationService,
    idempotencyStore,
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
    governanceReader,
    governanceActionStore,
    auditLogStore,
  };
}

async function readStoredAction(store: GovernanceActionStore, actionId: string) {
  const action = await store.get(actionId);
  if (!action) {
    throw new Error(`Expected stored governance action ${actionId}`);
  }

  return action;
}

describe('gateway governance mutation routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateAccepted = createSchemaValidator(spec, '#/components/schemas/GovernanceActionAcceptedResponse');
  const validateError = createSchemaValidator(spec, '#/components/schemas/ErrorResponse');

  test('OpenAPI spec exposes all governance mutation endpoints', () => {
    const mutationPaths = [
      '/governance/pause',
      '/governance/unpause/proposal',
      '/governance/unpause/proposal/approve',
      '/governance/unpause/proposal/cancel',
      '/governance/claims/pause',
      '/governance/claims/unpause',
      '/governance/treasury/sweep',
      '/governance/treasury/payout-receiver/proposals',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/approve',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/execute',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/cancel-expired',
      '/governance/oracle/disable-emergency',
      '/governance/oracle/proposals',
      '/governance/oracle/proposals/{proposalId}/approve',
      '/governance/oracle/proposals/{proposalId}/execute',
      '/governance/oracle/proposals/{proposalId}/cancel-expired',
    ];

    mutationPaths.forEach((routePath) => {
      expect(hasOperation(spec, 'post', routePath)).toBe(true);
    });
  });

  test.each([
    {
      name: 'pause protocol',
      path: '/governance/pause',
      body: buildAuditBody(),
      expectedCategory: 'pause',
      expectedMethod: 'pause',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    },
    {
      name: 'propose unpause',
      path: '/governance/unpause/proposal',
      body: buildAuditBody(),
      expectedCategory: 'unpause',
      expectedMethod: 'proposeUnpause',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: true, oracleActive: true }));
      },
    },
    {
      name: 'approve unpause',
      path: '/governance/unpause/proposal/approve',
      body: buildAuditBody(),
      expectedCategory: 'unpause',
      expectedMethod: 'approveUnpause',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getUnpauseProposalState.mockResolvedValue(buildUnpauseProposal({ hasActiveProposal: true, approvalCount: 1 }));
        reader.hasApprovedUnpause.mockResolvedValue(false);
      },
    },
    {
      name: 'cancel unpause',
      path: '/governance/unpause/proposal/cancel',
      body: buildAuditBody(),
      expectedCategory: 'unpause',
      expectedMethod: 'cancelUnpauseProposal',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getUnpauseProposalState.mockResolvedValue(buildUnpauseProposal({ hasActiveProposal: true }));
      },
    },
    {
      name: 'pause claims',
      path: '/governance/claims/pause',
      body: buildAuditBody(),
      expectedCategory: 'claims_pause',
      expectedMethod: 'pauseClaims',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ claimsPaused: false }));
      },
    },
    {
      name: 'unpause claims',
      path: '/governance/claims/unpause',
      body: buildAuditBody(),
      expectedCategory: 'claims_unpause',
      expectedMethod: 'unpauseClaims',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ claimsPaused: true }));
      },
    },
    {
      name: 'queue treasury sweep',
      path: '/governance/treasury/sweep',
      body: buildAuditBody(),
      expectedCategory: 'treasury_sweep',
      expectedMethod: 'claimTreasury',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ claimsPaused: false }));
        reader.getTreasuryClaimableBalance.mockResolvedValue(25n);
      },
    },
    {
      name: 'propose treasury payout receiver update',
      path: '/governance/treasury/payout-receiver/proposals',
      body: buildAuditBody({ newPayoutReceiver: '0x0000000000000000000000000000000000000099' }),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'proposeTreasuryPayoutAddressUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({
          treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
        }));
      },
    },
    {
      name: 'approve treasury payout receiver proposal',
      path: '/governance/treasury/payout-receiver/proposals/7/approve',
      body: buildAuditBody(),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'approveTreasuryPayoutAddressUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getTreasuryPayoutReceiverProposalState.mockResolvedValue(buildProposalState({
          proposalId: 7,
          approvalCount: 1,
          expired: false,
          cancelled: false,
          executed: false,
        }));
        reader.hasApprovedTreasuryPayoutReceiverProposal.mockResolvedValue(false);
      },
    },
    {
      name: 'execute treasury payout receiver proposal',
      path: '/governance/treasury/payout-receiver/proposals/7/execute',
      body: buildAuditBody(),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'executeTreasuryPayoutAddressUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ governanceApprovalsRequired: 2 }));
        reader.getTreasuryPayoutReceiverProposalState.mockResolvedValue(buildProposalState({
          proposalId: 7,
          approvalCount: 2,
          etaSeconds: Math.floor(Date.now() / 1000) - 5,
        }));
      },
    },
    {
      name: 'cancel expired treasury payout receiver proposal',
      path: '/governance/treasury/payout-receiver/proposals/7/cancel-expired',
      body: buildAuditBody(),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'cancelExpiredTreasuryPayoutAddressUpdateProposal',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getTreasuryPayoutReceiverProposalState.mockResolvedValue(buildProposalState({
          proposalId: 7,
          expired: true,
        }));
      },
    },
    {
      name: 'disable oracle emergency',
      path: '/governance/oracle/disable-emergency',
      body: buildAuditBody(),
      expectedCategory: 'oracle_disable_emergency',
      expectedMethod: 'disableOracleEmergency',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ oracleActive: true }));
      },
    },
    {
      name: 'propose oracle update',
      path: '/governance/oracle/proposals',
      body: buildAuditBody({ newOracleAddress: '0x00000000000000000000000000000000000000f1' }),
      expectedCategory: 'oracle_update',
      expectedMethod: 'proposeOracleUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({
          oracleAddress: '0x0000000000000000000000000000000000000011',
        }));
      },
    },
    {
      name: 'approve oracle proposal',
      path: '/governance/oracle/proposals/7/approve',
      body: buildAuditBody(),
      expectedCategory: 'oracle_update',
      expectedMethod: 'approveOracleUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getOracleProposalState.mockResolvedValue(buildProposalState({
          proposalId: 7,
          approvalCount: 1,
          expired: false,
          cancelled: false,
          executed: false,
        }));
        reader.hasApprovedOracleProposal.mockResolvedValue(false);
      },
    },
    {
      name: 'execute oracle proposal',
      path: '/governance/oracle/proposals/7/execute',
      body: buildAuditBody(),
      expectedCategory: 'oracle_update',
      expectedMethod: 'executeOracleUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ governanceApprovalsRequired: 2 }));
        reader.getOracleProposalState.mockResolvedValue(buildProposalState({
          proposalId: 7,
          approvalCount: 2,
          etaSeconds: Math.floor(Date.now() / 1000) - 5,
        }));
      },
    },
    {
      name: 'cancel expired oracle proposal',
      path: '/governance/oracle/proposals/7/cancel-expired',
      body: buildAuditBody(),
      expectedCategory: 'oracle_update',
      expectedMethod: 'cancelExpiredOracleUpdateProposal',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getOracleProposalState.mockResolvedValue(buildProposalState({
          proposalId: 7,
          expired: true,
        }));
      },
    },
  ])('POST $path accepts and persists $name', async ({ path, body, expectedCategory, expectedMethod, configureReader }) => {
    const { server, baseUrl, governanceActionStore } = await startServer({ configureReader });

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': `idem-${expectedMethod}`,
          'x-request-id': `req-${expectedMethod}`,
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      expect(response.status).toBe(202);
      expect(response.headers.get('x-request-id')).toBe(`req-${expectedMethod}`);
      expect(validateAccepted(payload)).toBe(true);
      expect(payload.data.category).toBe(expectedCategory);
      expect(payload.data.status).toBe('requested');

      const storedAction = await readStoredAction(governanceActionStore, payload.data.actionId);
      expect(storedAction.category).toBe(expectedCategory);
      expect(storedAction.contractMethod).toBe(expectedMethod);
      expect(storedAction.requestId).toBe(`req-${expectedMethod}`);
    } finally {
      server.close();
    }
  });

  test('mutation routes replay accepted responses for duplicate idempotency keys', async () => {
    const { server, baseUrl, governanceActionStore, auditLogStore } = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const headers = {
        Authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-pause',
      };
      const body = JSON.stringify(buildAuditBody());

      const first = await fetch(`${baseUrl}/governance/pause`, { method: 'POST', headers, body });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/governance/pause`, { method: 'POST', headers, body });
      const secondPayload = await second.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers.get('x-idempotent-replay')).toBe('true');
      expect(firstPayload).toEqual(secondPayload);

      const stored = await governanceActionStore.list({ limit: 10 });
      expect(stored.items).toHaveLength(1);
      expect(auditLogStore.entries).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  test('mutation routes enforce authentication and write gating deterministically', async () => {
    const unauthenticated = await startServer({ sessionRole: null });
    const nonAdmin = await startServer({ sessionRole: 'buyer' });
    const disabled = await startServer({ enableMutations: false });
    const notAllowlisted = await startServer({ writeAllowlist: [] });

    try {
      const requestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-authz',
        },
        body: JSON.stringify(buildAuditBody()),
      };

      const unauthenticatedResponse = await fetch(`${unauthenticated.baseUrl}/governance/pause`, requestInit);
      const unauthenticatedPayload = await unauthenticatedResponse.json();
      expect(unauthenticatedResponse.status).toBe(401);
      expect(validateError(unauthenticatedPayload)).toBe(true);
      expect(unauthenticatedPayload.error.code).toBe('AUTH_REQUIRED');

      const nonAdminResponse = await fetch(`${nonAdmin.baseUrl}/governance/pause`, {
        ...requestInit,
        headers: {
          ...requestInit.headers,
          Authorization: 'Bearer sess-buyer',
        },
      });
      const nonAdminPayload = await nonAdminResponse.json();
      expect(nonAdminResponse.status).toBe(403);
      expect(nonAdminPayload.error.code).toBe('FORBIDDEN');

      const disabledResponse = await fetch(`${disabled.baseUrl}/governance/pause`, {
        ...requestInit,
        headers: {
          ...requestInit.headers,
          Authorization: 'Bearer sess-admin',
        },
      });
      const disabledPayload = await disabledResponse.json();
      expect(disabledResponse.status).toBe(403);
      expect(disabledPayload.error.code).toBe('FORBIDDEN');

      const notAllowlistedResponse = await fetch(`${notAllowlisted.baseUrl}/governance/pause`, {
        ...requestInit,
        headers: {
          ...requestInit.headers,
          Authorization: 'Bearer sess-admin',
        },
      });
      const notAllowlistedPayload = await notAllowlistedResponse.json();
      expect(notAllowlistedResponse.status).toBe(403);
      expect(notAllowlistedPayload.error.code).toBe('FORBIDDEN');
    } finally {
      unauthenticated.server.close();
      nonAdmin.server.close();
      disabled.server.close();
      notAllowlisted.server.close();
    }
  });

  test('mutation routes reject invalid payloads and state conflicts with schema-valid errors', async () => {
    const invalidServer = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });
    const conflictServer = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: true }));
        reader.getOracleProposalState.mockResolvedValue(null);
      },
    });

    try {
      const invalidResponse = await fetch(`${invalidServer.baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-invalid',
        },
        body: JSON.stringify({}),
      });
      const invalidPayload = await invalidResponse.json();
      expect(invalidResponse.status).toBe(400);
      expect(validateError(invalidPayload)).toBe(true);
      expect(invalidPayload.error.code).toBe('VALIDATION_ERROR');

      const conflictResponse = await fetch(`${conflictServer.baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-conflict',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const conflictPayload = await conflictResponse.json();
      expect(conflictResponse.status).toBe(409);
      expect(validateError(conflictPayload)).toBe(true);
      expect(conflictPayload.error.code).toBe('CONFLICT');

      const missingResponse = await fetch(`${conflictServer.baseUrl}/governance/oracle/proposals/99/approve`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-missing',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const missingPayload = await missingResponse.json();
      expect(missingResponse.status).toBe(404);
      expect(validateError(missingPayload)).toBe(true);
      expect(missingPayload.error.code).toBe('NOT_FOUND');
    } finally {
      invalidServer.server.close();
      conflictServer.server.close();
    }
  });
});
