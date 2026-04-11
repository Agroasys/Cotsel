/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { formatUnits } from 'ethers';
import type { GovernanceMutationPreflightReader } from './governanceStatusService';
import type {
  GovernanceActionCategory,
  GovernanceActionRecord,
  GovernanceActionStatus,
  GovernanceActionStore,
} from './governanceStore';

export const TREASURY_ACTION_CATEGORIES = [
  'treasury_sweep',
  'treasury_payout_receiver_update',
] as const;

export type TreasuryActionCategory = (typeof TREASURY_ACTION_CATEGORIES)[number];

export interface TreasuryFreshness {
  source: 'chain_rpc' | 'gateway_governance_ledger';
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

export interface TreasuryActionListResult {
  items: GovernanceActionRecord[];
  nextCursor: string | null;
  freshness: TreasuryFreshness;
}

export interface TreasuryActionListQuery {
  category?: TreasuryActionCategory;
  status?: GovernanceActionStatus;
  limit: number;
  cursor?: string;
}

export interface TreasuryReadReader {
  getTreasurySnapshot(): Promise<TreasurySnapshotResult>;
  listTreasuryActions(query: TreasuryActionListQuery): Promise<TreasuryActionListResult>;
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

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestValue: string | null = null;

  for (const value of values) {
    if (!value) {
      continue;
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      continue;
    }

    if (parsed > latestMs) {
      latestMs = parsed;
      latestValue = new Date(parsed).toISOString();
    }
  }

  return latestValue;
}

export class TreasuryReadService implements TreasuryReadReader {
  constructor(
    private readonly governanceReader: GovernanceMutationPreflightReader,
    private readonly governanceActionStore: GovernanceActionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getTreasurySnapshot(): Promise<TreasurySnapshotResult> {
    const queriedAt = this.now().toISOString();

    try {
      const treasuryPayoutReceiverProposalIds =
        await this.governanceActionStore.listActiveProposalIds('treasury_payout_receiver_update');
      const [status, claimableBalance] = await Promise.all([
        this.governanceReader.getGovernanceStatus({
          treasuryPayoutReceiverProposalIds,
        }),
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

  async listTreasuryActions(query: TreasuryActionListQuery): Promise<TreasuryActionListResult> {
    const queriedAt = this.now().toISOString();

    try {
      const result = await this.governanceActionStore.list({
        categories: query.category
          ? [query.category]
          : ([...TREASURY_ACTION_CATEGORIES] as GovernanceActionCategory[]),
        status: query.status,
        limit: query.limit,
        cursor: query.cursor,
      });

      return {
        items: result.items,
        nextCursor: result.nextCursor,
        freshness: {
          source: 'gateway_governance_ledger',
          sourceFreshAt: maxTimestamp(
            result.items.flatMap((item) => [item.executedAt, item.createdAt]),
          ),
          queriedAt,
          available: true,
        },
      };
    } catch (error) {
      return {
        items: [],
        nextCursor: null,
        freshness: {
          source: 'gateway_governance_ledger',
          sourceFreshAt: null,
          queriedAt,
          available: false,
          degradedReason: degradedReason(error),
        },
      };
    }
  }
}
