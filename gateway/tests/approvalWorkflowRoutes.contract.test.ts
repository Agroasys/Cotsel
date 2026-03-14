/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import {
  GovernanceApprovalWorkflowReadService,
} from '../src/core/approvalWorkflowReadService';
import {
  buildGovernanceIntentKey,
  createInMemoryGovernanceActionStore,
  GovernanceActionRecord,
} from '../src/core/governanceStore';
import {
  GovernanceMutationPreflightReader,
  GovernanceProposalState,
  GovernanceStatusSnapshot,
  UnpauseProposalState,
} from '../src/core/governanceStatusService';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createApprovalWorkflowRouter } from '../src/routes/approvals';
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
};

const seededActions: GovernanceActionRecord[] = [
  {
    actionId: 'approval-2',
    intentKey: buildGovernanceIntentKey({
      category: 'oracle_update',
      contractMethod: 'proposeOracleUpdate',
      proposalId: 7,
      targetAddress: '0x0000000000000000000000000000000000000044',
      chainId: '31337',
    }),
    proposalId: 7,
    category: 'oracle_update',
    status: 'pending_approvals',
    contractMethod: 'proposeOracleUpdate',
    txHash: '0xreq2',
    extrinsicHash: null,
    blockNumber: 22,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000044',
    createdAt: '2026-03-14T10:10:00.000Z',
    expiresAt: '2026-03-15T10:10:00.000Z',
    executedAt: '2026-03-14T10:11:00.000Z',
    requestId: 'req-2',
    correlationId: 'corr-2',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Rotate oracle after governance review.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-245' }],
      ticketRef: 'AGRO-245',
      actorSessionId: 'sess-2',
      actorWallet: '0x00000000000000000000000000000000000000a2',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:10:00.000Z',
      requestedBy: 'uid-admin-2',
    },
  },
  {
    actionId: 'approval-2-review',
    intentKey: buildGovernanceIntentKey({
      category: 'oracle_update',
      contractMethod: 'approveOracleUpdate',
      proposalId: 7,
      targetAddress: '0x0000000000000000000000000000000000000044',
      chainId: '31337',
      approverWallet: '0x00000000000000000000000000000000000000a3',
    }),
    proposalId: 7,
    category: 'oracle_update',
    status: 'approved',
    contractMethod: 'approveOracleUpdate',
    txHash: '0xapprove2',
    extrinsicHash: null,
    blockNumber: 23,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000044',
    createdAt: '2026-03-14T10:12:00.000Z',
    expiresAt: '2026-03-15T10:12:00.000Z',
    executedAt: '2026-03-14T10:13:00.000Z',
    requestId: 'req-2-review',
    correlationId: 'corr-2-review',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Approve oracle rotation.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-246' }],
      ticketRef: 'AGRO-246',
      actorSessionId: 'sess-2-review',
      actorWallet: '0x00000000000000000000000000000000000000a3',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:12:00.000Z',
      requestedBy: 'uid-admin-3',
    },
  },
  {
    actionId: 'approval-1',
    intentKey: buildGovernanceIntentKey({
      category: 'treasury_payout_receiver_update',
      contractMethod: 'proposeTreasuryPayoutAddressUpdate',
      proposalId: 4,
      targetAddress: '0x0000000000000000000000000000000000000055',
      chainId: '31337',
    }),
    proposalId: 4,
    category: 'treasury_payout_receiver_update',
    status: 'approved',
    contractMethod: 'proposeTreasuryPayoutAddressUpdate',
    txHash: '0xreq1',
    extrinsicHash: null,
    blockNumber: 21,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000055',
    createdAt: '2026-03-13T10:10:00.000Z',
    expiresAt: '2026-03-14T10:10:00.000Z',
    executedAt: '2026-03-13T10:11:00.000Z',
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Rotate treasury payout receiver.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-244' }],
      ticketRef: 'AGRO-244',
      actorSessionId: 'sess-1',
      actorWallet: '0x00000000000000000000000000000000000000a1',
      actorRole: 'admin',
      createdAt: '2026-03-13T10:10:00.000Z',
      requestedBy: 'uid-admin-1',
    },
  },
];

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
    activeOracleProposalIds: [7],
    activeTreasuryPayoutReceiverProposalIds: [4],
    ...overrides,
  };
}

function buildProposalState(overrides: Partial<GovernanceProposalState> = {}): GovernanceProposalState {
  return {
    proposalId: 7,
    approvalCount: 2,
    executed: false,
    cancelled: false,
    expired: false,
    etaSeconds: Math.floor(Date.now() / 1000) + 600,
    targetAddress: '0x0000000000000000000000000000000000000044',
    ...overrides,
  };
}

function buildUnpauseProposal(overrides: Partial<UnpauseProposalState> = {}): UnpauseProposalState {
  return {
    hasActiveProposal: false,
    approvalCount: 0,
    executed: false,
    ...overrides,
  };
}

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
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const governanceReader: jest.Mocked<GovernanceMutationPreflightReader> = {
    checkReadiness: jest.fn(),
    getGovernanceStatus: jest.fn().mockResolvedValue(buildStatusSnapshot()),
    getUnpauseProposalState: jest.fn().mockResolvedValue(buildUnpauseProposal()),
    getOracleProposalState: jest.fn().mockResolvedValue(buildProposalState()),
    getTreasuryPayoutReceiverProposalState: jest.fn().mockResolvedValue(buildProposalState({
      proposalId: 4,
      targetAddress: '0x0000000000000000000000000000000000000055',
    })),
    getTreasuryClaimableBalance: jest.fn().mockResolvedValue(10n),
    hasApprovedUnpause: jest.fn().mockResolvedValue(false),
    hasApprovedOracleProposal: jest.fn().mockResolvedValue(false),
    hasApprovedTreasuryPayoutReceiverProposal: jest.fn().mockResolvedValue(false),
  };

  const router = Router();
  router.use(createApprovalWorkflowRouter({
    authSessionClient,
    config,
    approvalWorkflowReadService: new GovernanceApprovalWorkflowReadService(
      createInMemoryGovernanceActionStore(seededActions),
      governanceReader,
    ),
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

describe('gateway approval workflow routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateList = createSchemaValidator(spec, '#/components/schemas/ApprovalWorkflowListResponse');
  const validateDetail = createSchemaValidator(spec, '#/components/schemas/ApprovalWorkflowDetailResponse');

  test('OpenAPI spec exposes approval workflow routes', () => {
    expect(hasOperation(spec, 'get', '/approvals')).toBe(true);
    expect(hasOperation(spec, 'get', '/approvals/{approvalId}')).toBe(true);
  });

  test('GET /approvals returns schema-valid approval workflow summaries', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/approvals?limit=1',
      headers: {
        authorization: 'Bearer sess-admin',
        'x-request-id': 'req-approvals',
      },
    });
    const payload = response.json<{
      data: {
        items: Array<{ approvalId: string; review: { approvedBy: string[] } }>;
        nextCursor: string | null;
      };
    }>();

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-approvals');
    expect(validateList(payload)).toBe(true);
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0].approvalId).toBe('approval-2');
    expect(payload.data.items[0].review.approvedBy).toEqual(['uid-admin-3']);
    expect(payload.data.nextCursor).toBeTruthy();
  });

  test('GET /approvals/{approvalId} returns schema-valid detail', async () => {
    const app = await startServer('admin');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/approvals/approval-2',
      headers: {
        authorization: 'Bearer sess-admin',
        'x-request-id': 'req-approval-detail',
      },
    });
    const payload = response.json<{ data: { approvalId: string; review: { items: Array<{ actionId: string }> } } }>();

    expect(response.status).toBe(200);
    expect(validateDetail(payload)).toBe(true);
    expect(payload.data.approvalId).toBe('approval-2');
    expect(payload.data.review.items[0].actionId).toBe('approval-2-review');
  });

  test('approval workflow routes require operator access', async () => {
    const app = await startServer('buyer');
    const response = await sendInProcessRequest(app, {
      method: 'GET',
      path: '/api/dashboard-gateway/v1/approvals',
      headers: { authorization: 'Bearer sess-buyer' },
    });
    const payload = response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe('FORBIDDEN');
  });
});
