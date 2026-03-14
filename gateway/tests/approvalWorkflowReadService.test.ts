/**
 * SPDX-License-Identifier: Apache-2.0
 */
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
    etaSeconds: Math.floor(Date.now() / 1000) + 600,
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

const seededActions: GovernanceActionRecord[] = [
  {
    actionId: 'oracle-proposal-request',
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
    txHash: '0xrequest',
    extrinsicHash: null,
    blockNumber: 51,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000044',
    createdAt: '2026-03-14T10:00:00.000Z',
    expiresAt: '2026-03-15T10:00:00.000Z',
    executedAt: '2026-03-14T10:01:00.000Z',
    requestId: 'req-request',
    correlationId: 'corr-request',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Rotate the oracle after anomaly review.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-245' }],
      ticketRef: 'AGRO-245',
      actorSessionId: 'sess-request',
      actorWallet: '0x00000000000000000000000000000000000000aa',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:00:00.000Z',
      requestedBy: 'uid-requester',
    },
  },
  {
    actionId: 'oracle-proposal-approve',
    intentKey: buildGovernanceIntentKey({
      category: 'oracle_update',
      contractMethod: 'approveOracleUpdate',
      proposalId: 7,
      targetAddress: '0x0000000000000000000000000000000000000044',
      chainId: '31337',
      approverWallet: '0x00000000000000000000000000000000000000bb',
    }),
    proposalId: 7,
    category: 'oracle_update',
    status: 'approved',
    contractMethod: 'approveOracleUpdate',
    txHash: '0xapprove',
    extrinsicHash: null,
    blockNumber: 52,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000044',
    createdAt: '2026-03-14T10:05:00.000Z',
    expiresAt: '2026-03-15T10:05:00.000Z',
    executedAt: '2026-03-14T10:06:00.000Z',
    requestId: 'req-approve',
    correlationId: 'corr-approve',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Second approver confirmed the proposed oracle.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-246' }],
      ticketRef: 'AGRO-246',
      actorSessionId: 'sess-approve',
      actorWallet: '0x00000000000000000000000000000000000000bb',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:05:00.000Z',
      requestedBy: 'uid-reviewer',
    },
  },
  {
    actionId: 'oracle-proposal-execute',
    intentKey: buildGovernanceIntentKey({
      category: 'oracle_update',
      contractMethod: 'executeOracleUpdate',
      proposalId: 7,
      targetAddress: '0x0000000000000000000000000000000000000044',
      chainId: '31337',
    }),
    proposalId: 7,
    category: 'oracle_update',
    status: 'executed',
    contractMethod: 'executeOracleUpdate',
    txHash: '0xexecute',
    extrinsicHash: null,
    blockNumber: 53,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000044',
    createdAt: '2026-03-14T10:10:00.000Z',
    expiresAt: '2026-03-15T10:10:00.000Z',
    executedAt: '2026-03-14T10:11:00.000Z',
    requestId: 'req-execute',
    correlationId: 'corr-execute',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Timelock elapsed and the approved proposal was executed.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-247' }],
      ticketRef: 'AGRO-247',
      actorSessionId: 'sess-execute',
      actorWallet: '0x00000000000000000000000000000000000000cc',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:10:00.000Z',
      requestedBy: 'uid-executor',
    },
  },
  {
    actionId: 'treasury-proposal-request',
    intentKey: buildGovernanceIntentKey({
      category: 'treasury_payout_receiver_update',
      contractMethod: 'proposeTreasuryPayoutAddressUpdate',
      proposalId: 9,
      targetAddress: '0x0000000000000000000000000000000000000055',
      chainId: '31337',
    }),
    proposalId: 9,
    category: 'treasury_payout_receiver_update',
    status: 'pending_approvals',
    contractMethod: 'proposeTreasuryPayoutAddressUpdate',
    txHash: null,
    extrinsicHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000055',
    createdAt: '2026-03-13T10:00:00.000Z',
    expiresAt: '2026-03-14T10:00:00.000Z',
    executedAt: null,
    requestId: 'req-treasury',
    correlationId: 'corr-treasury',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Rotate treasury payout receiver.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-248' }],
      ticketRef: 'AGRO-248',
      actorSessionId: 'sess-treasury',
      actorWallet: '0x00000000000000000000000000000000000000dd',
      actorRole: 'admin',
      createdAt: '2026-03-13T10:00:00.000Z',
      requestedBy: 'uid-treasury',
    },
  },
];

function buildReader(): jest.Mocked<GovernanceMutationPreflightReader> {
  return {
    checkReadiness: jest.fn(),
    getGovernanceStatus: jest.fn().mockResolvedValue(buildStatusSnapshot()),
    getUnpauseProposalState: jest.fn().mockResolvedValue(buildUnpauseProposal()),
    getOracleProposalState: jest.fn().mockResolvedValue(buildProposalState({ executed: true, approvalCount: 2 })),
    getTreasuryPayoutReceiverProposalState: jest.fn().mockResolvedValue(buildProposalState({
      proposalId: 9,
      targetAddress: '0x0000000000000000000000000000000000000055',
    })),
    getTreasuryClaimableBalance: jest.fn().mockResolvedValue(10n),
    hasApprovedUnpause: jest.fn().mockResolvedValue(false),
    hasApprovedOracleProposal: jest.fn().mockResolvedValue(false),
    hasApprovedTreasuryPayoutReceiverProposal: jest.fn().mockResolvedValue(false),
  };
}

describe('GovernanceApprovalWorkflowReadService', () => {
  test('lists only approval workflow requests and resolves live approval status', async () => {
    const service = new GovernanceApprovalWorkflowReadService(
      createInMemoryGovernanceActionStore(seededActions),
      buildReader(),
    );

    const result = await service.list({ limit: 10 });

    expect(result.available).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      approvalId: 'oracle-proposal-request',
      category: 'oracle_update',
      review: {
        approvalsRequired: 2,
        approvalCount: 2,
        approvedBy: ['uid-reviewer'],
      },
      status: {
        current: 'executed',
        pendingExecution: false,
      },
      execution: {
        actionId: 'oracle-proposal-execute',
        contractMethod: 'executeOracleUpdate',
        txHash: '0xexecute',
      },
    });
    expect(result.items[1]?.approvalId).toBe('treasury-proposal-request');
  });

  test('returns detail with review events ordered newest first', async () => {
    const service = new GovernanceApprovalWorkflowReadService(
      createInMemoryGovernanceActionStore(seededActions),
      buildReader(),
    );

    const result = await service.get('oracle-proposal-request');

    expect(result).not.toBeNull();
    expect(result?.review.items).toHaveLength(2);
    expect(result?.review.items[0]).toMatchObject({
      actionId: 'oracle-proposal-execute',
      reviewType: 'execute',
      reviewedBy: 'uid-executor',
    });
    expect(result?.review.items[1]).toMatchObject({
      actionId: 'oracle-proposal-approve',
      reviewType: 'approve',
      reviewedBy: 'uid-reviewer',
    });
  });

  test('degrades explicitly when live governance reads are unavailable', async () => {
    const reader = buildReader();
    reader.getGovernanceStatus.mockRejectedValue(new Error('governance rpc unavailable'));

    const service = new GovernanceApprovalWorkflowReadService(
      createInMemoryGovernanceActionStore(seededActions),
      reader,
    );

    const result = await service.get('treasury-proposal-request');

    expect(result).not.toBeNull();
    expect(result?.available).toBe(false);
    expect(result?.degradedReason).toContain('governance rpc unavailable');
    expect(result?.review.approvalsRequired).toBeNull();
    expect(result?.status.current).toBe('pending_approvals');
  });
});
