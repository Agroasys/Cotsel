/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { TreasuryReadService } from '../src/core/treasuryReadService';
import type { GovernanceMutationPreflightReader } from '../src/core/governanceStatusService';

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

  test('surfaces blocked sweep visibility when claims are paused or claimable balance is zero', async () => {
    const baseStatus = {
      paused: false,
      claimsPaused: true,
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
    };
    const claimsPausedReader: GovernanceMutationPreflightReader = {
      checkReadiness: jest.fn(),
      getGovernanceStatus: jest.fn().mockResolvedValue(baseStatus),
      getUnpauseProposalState: jest.fn(),
      getOracleProposalState: jest.fn(),
      getTreasuryPayoutReceiverProposalState: jest.fn(),
      getTreasuryClaimableBalance: jest.fn().mockResolvedValue(125000000n),
      hasApprovedUnpause: jest.fn(),
      hasApprovedOracleProposal: jest.fn(),
      hasApprovedTreasuryPayoutReceiverProposal: jest.fn(),
    };

    const zeroBalanceReader: GovernanceMutationPreflightReader = {
      ...claimsPausedReader,
      getGovernanceStatus: jest.fn().mockResolvedValue({
        ...baseStatus,
        claimsPaused: false,
      }),
      getTreasuryClaimableBalance: jest.fn().mockResolvedValue(0n),
    };

    const claimsPausedService = new TreasuryReadService(
      claimsPausedReader,
      () => new Date('2026-03-14T11:00:00.000Z'),
    );
    const zeroBalanceService = new TreasuryReadService(
      zeroBalanceReader,
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const pausedSnapshot = await claimsPausedService.getTreasurySnapshot();
    const zeroBalanceSnapshot = await zeroBalanceService.getTreasurySnapshot();

    expect(pausedSnapshot.state?.sweepVisibility).toEqual({
      canSweep: false,
      blockedReason: 'claims_paused',
    });
    expect(zeroBalanceSnapshot.state?.sweepVisibility).toEqual({
      canSweep: false,
      blockedReason: 'no_claimable_balance',
    });
  });

  test('returns a degraded snapshot when the chain read is unavailable', async () => {
    const governanceReader: GovernanceMutationPreflightReader = {
      checkReadiness: jest.fn(),
      getGovernanceStatus: jest.fn().mockRejectedValue(new Error('chain rpc unavailable')),
      getUnpauseProposalState: jest.fn(),
      getOracleProposalState: jest.fn(),
      getTreasuryPayoutReceiverProposalState: jest.fn(),
      getTreasuryClaimableBalance: jest.fn().mockResolvedValue(0n),
      hasApprovedUnpause: jest.fn(),
      hasApprovedOracleProposal: jest.fn(),
      hasApprovedTreasuryPayoutReceiverProposal: jest.fn(),
    };

    const service = new TreasuryReadService(
      governanceReader,
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const snapshot = await service.getTreasurySnapshot();

    expect(snapshot.state).toBeNull();
    expect(snapshot.freshness).toEqual({
      source: 'chain_rpc',
      sourceFreshAt: null,
      queriedAt: '2026-03-14T11:00:00.000Z',
      available: false,
      degradedReason: 'chain rpc unavailable',
    });
  });
});
