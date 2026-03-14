/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  buildGovernanceIntentKey,
  createInMemoryGovernanceActionStore,
  GovernanceActionRecord,
} from '../src/core/governanceStore';
import { TreasuryReadService } from '../src/core/treasuryReadService';
import type { GovernanceMutationPreflightReader } from '../src/core/governanceStatusService';

const seededActions: GovernanceActionRecord[] = [
  {
    actionId: 'gov-treasury-2',
    intentKey: buildGovernanceIntentKey({
      category: 'treasury_payout_receiver_update',
      contractMethod: 'proposeTreasuryPayoutAddressUpdate',
      proposalId: 11,
      targetAddress: '0x0000000000000000000000000000000000000034',
      chainId: '31337',
    }),
    proposalId: 11,
    category: 'treasury_payout_receiver_update',
    status: 'pending_approvals',
    contractMethod: 'proposeTreasuryPayoutAddressUpdate',
    txHash: null,
    extrinsicHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: '0x0000000000000000000000000000000000000034',
    createdAt: '2026-03-14T10:10:00.000Z',
    expiresAt: '2026-03-15T10:10:00.000Z',
    executedAt: null,
    requestId: 'req-2',
    correlationId: 'corr-2',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Rotate payout receiver.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-2' }],
      ticketRef: 'AGRO-2',
      actorSessionId: 'sess-2',
      actorWallet: '0x00000000000000000000000000000000000000b2',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:10:00.000Z',
      requestedBy: 'uid-admin-2',
      approvedBy: ['uid-admin-1'],
    },
  },
  {
    actionId: 'gov-treasury-1',
    intentKey: buildGovernanceIntentKey({
      category: 'treasury_sweep',
      contractMethod: 'sweepTreasury',
      chainId: '31337',
    }),
    proposalId: null,
    category: 'treasury_sweep',
    status: 'executed',
    contractMethod: 'sweepTreasury',
    txHash: '0xabc',
    extrinsicHash: null,
    blockNumber: 17,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    createdAt: '2026-03-14T10:00:00.000Z',
    expiresAt: '2026-03-15T10:00:00.000Z',
    executedAt: '2026-03-14T10:01:00.000Z',
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Sweep treasury.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-1' }],
      ticketRef: 'AGRO-1',
      actorSessionId: 'sess-1',
      actorWallet: '0x00000000000000000000000000000000000000a1',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:00:00.000Z',
      requestedBy: 'uid-admin-1',
    },
  },
];

describe('treasury read service', () => {
  test('returns treasury state with explicit sweep visibility', async () => {
    const governanceReader: GovernanceMutationPreflightReader = {
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
        requiredAdminCount: 2,
        hasActiveUnpauseProposal: false,
        activeUnpauseApprovals: 0,
        activeOracleProposalIds: [],
        activeTreasuryPayoutReceiverProposalIds: [11],
      }),
      getUnpauseProposalState: jest.fn(),
      getOracleProposalState: jest.fn(),
      getTreasuryPayoutReceiverProposalState: jest.fn(),
      getTreasuryClaimableBalance: jest.fn().mockResolvedValue(125000000n),
      hasApprovedUnpause: jest.fn(),
      hasApprovedOracleProposal: jest.fn(),
      hasApprovedTreasuryPayoutReceiverProposal: jest.fn(),
    };

    const service = new TreasuryReadService(
      governanceReader,
      createInMemoryGovernanceActionStore(seededActions),
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const snapshot = await service.getTreasurySnapshot();

    expect(snapshot).toEqual({
      state: {
        paused: false,
        claimsPaused: false,
        treasuryAddress: '0x0000000000000000000000000000000000000022',
        treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
        governanceApprovalsRequired: 2,
        governanceTimelockSeconds: 86400,
        requiredAdminCount: 2,
        claimableBalance: {
          assetSymbol: 'USDC',
          raw: '125000000',
          display: '125.0',
        },
        sweepVisibility: {
          canSweep: true,
          blockedReason: null,
        },
        payoutReceiverVisibility: {
          currentAddress: '0x0000000000000000000000000000000000000033',
          hasPendingUpdate: true,
          activeProposalIds: [11],
        },
      },
      freshness: {
        source: 'chain_rpc',
        sourceFreshAt: '2026-03-14T11:00:00.000Z',
        queriedAt: '2026-03-14T11:00:00.000Z',
        available: true,
      },
    });
  });

  test('lists treasury governance actions through the treasury contract filter', async () => {
    const governanceReader = {
      checkReadiness: jest.fn(),
      getGovernanceStatus: jest.fn(),
      getUnpauseProposalState: jest.fn(),
      getOracleProposalState: jest.fn(),
      getTreasuryPayoutReceiverProposalState: jest.fn(),
      getTreasuryClaimableBalance: jest.fn(),
      hasApprovedUnpause: jest.fn(),
      hasApprovedOracleProposal: jest.fn(),
      hasApprovedTreasuryPayoutReceiverProposal: jest.fn(),
    } as unknown as GovernanceMutationPreflightReader;

    const service = new TreasuryReadService(
      governanceReader,
      createInMemoryGovernanceActionStore(seededActions),
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const result = await service.listTreasuryActions({
      limit: 10,
      category: 'treasury_sweep',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.category).toBe('treasury_sweep');
    expect(result.freshness).toEqual({
      source: 'gateway_governance_ledger',
      sourceFreshAt: '2026-03-14T10:01:00.000Z',
      queriedAt: '2026-03-14T11:00:00.000Z',
      available: true,
    });
  });
});
