/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { formatUnits } from 'ethers';
import type { GovernanceMutationPreflightReader } from './governanceStatusService';

export interface TreasuryFreshness {
  source: 'chain_rpc';
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
  degradedReason?: string;
}

export interface TreasuryBalanceSnapshot {
  assetSymbol: 'USDC';
  raw: string;
  display: string;
}

export interface TreasuryStateSnapshot {
  paused: boolean;
  claimsPaused: boolean;
  treasuryAddress: string;
  treasuryPayoutAddress: string;
  governanceApprovalsRequired: number;
  governanceTimelockSeconds: number;
  requiredAdminCount: number;
  claimableBalance: TreasuryBalanceSnapshot;
  sweepVisibility: {
    canSweep: boolean;
    blockedReason: 'claims_paused' | 'no_claimable_balance' | null;
  };
  payoutReceiverVisibility: {
    currentAddress: string;
    hasPendingUpdate: boolean;
    activeProposalIds: number[];
  };
}

export interface TreasurySnapshotResult {
  state: TreasuryStateSnapshot | null;
  freshness: TreasuryFreshness;
}

export interface TreasuryReadReader {
  getTreasurySnapshot(): Promise<TreasurySnapshotResult>;
}

function asDisplayAmount(value: bigint): string {
  return formatUnits(value, 6);
}

function degradedReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Treasury source is unavailable';
}

export class TreasuryReadService implements TreasuryReadReader {
  constructor(
    private readonly governanceReader: GovernanceMutationPreflightReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getTreasurySnapshot(): Promise<TreasurySnapshotResult> {
    const queriedAt = this.now().toISOString();

    try {
      const [status, claimableBalance] = await Promise.all([
        this.governanceReader.getGovernanceStatus(),
        this.governanceReader.getTreasuryClaimableBalance(),
      ]);

      const hasClaimableBalance = claimableBalance > 0n;

      return {
        state: {
          paused: status.paused,
          claimsPaused: status.claimsPaused,
          treasuryAddress: status.treasuryAddress,
          treasuryPayoutAddress: status.treasuryPayoutAddress,
          governanceApprovalsRequired: status.governanceApprovalsRequired,
          governanceTimelockSeconds: status.governanceTimelockSeconds,
          requiredAdminCount: status.requiredAdminCount,
          claimableBalance: {
            assetSymbol: 'USDC',
            raw: claimableBalance.toString(),
            display: asDisplayAmount(claimableBalance),
          },
          sweepVisibility: {
            canSweep: !status.claimsPaused && hasClaimableBalance,
            blockedReason: status.claimsPaused
              ? 'claims_paused'
              : hasClaimableBalance
                ? null
                : 'no_claimable_balance',
          },
          payoutReceiverVisibility: {
            currentAddress: status.treasuryPayoutAddress,
            hasPendingUpdate: status.activeTreasuryPayoutReceiverProposalIds.length > 0,
            activeProposalIds: status.activeTreasuryPayoutReceiverProposalIds,
          },
        },
        freshness: {
          source: 'chain_rpc',
          sourceFreshAt: queriedAt,
          queriedAt,
          available: true,
        },
      };
    } catch (error) {
      return {
        state: null,
        freshness: {
          source: 'chain_rpc',
          sourceFreshAt: null,
          queriedAt,
          available: false,
          degradedReason: degradedReason(error),
        },
      };
    }
  }
}
