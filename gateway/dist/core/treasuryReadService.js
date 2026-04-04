"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TreasuryReadService = exports.TREASURY_ACTION_CATEGORIES = void 0;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const ethers_1 = require("ethers");
exports.TREASURY_ACTION_CATEGORIES = [
    'treasury_sweep',
    'treasury_payout_receiver_update',
];
function asDisplayAmount(value) {
    return (0, ethers_1.formatUnits)(value, 6);
}
function degradedReason(error) {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return 'Treasury source is unavailable';
}
function maxTimestamp(values) {
    let latestMs = Number.NEGATIVE_INFINITY;
    let latestValue = null;
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
class TreasuryReadService {
    constructor(governanceReader, governanceActionStore, now = () => new Date()) {
        this.governanceReader = governanceReader;
        this.governanceActionStore = governanceActionStore;
        this.now = now;
    }
    async getTreasurySnapshot() {
        const queriedAt = this.now().toISOString();
        try {
            const treasuryPayoutReceiverProposalIds = await this.governanceActionStore.listActiveProposalIds('treasury_payout_receiver_update');
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
        }
        catch (error) {
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
    async listTreasuryActions(query) {
        const queriedAt = this.now().toISOString();
        try {
            const result = await this.governanceActionStore.list({
                categories: query.category
                    ? [query.category]
                    : [...exports.TREASURY_ACTION_CATEGORIES],
                status: query.status,
                limit: query.limit,
                cursor: query.cursor,
            });
            return {
                items: result.items,
                nextCursor: result.nextCursor,
                freshness: {
                    source: 'gateway_governance_ledger',
                    sourceFreshAt: maxTimestamp(result.items.flatMap((item) => [item.executedAt, item.createdAt])),
                    queriedAt,
                    available: true,
                },
            };
        }
        catch (error) {
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
exports.TreasuryReadService = TreasuryReadService;
//# sourceMappingURL=treasuryReadService.js.map