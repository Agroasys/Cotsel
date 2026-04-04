"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernanceStatusService = void 0;
exports.createGovernanceStatusService = createGovernanceStatusService;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const ethers_1 = require("ethers");
const failoverProvider_1 = require("@agroasys/sdk/rpc/failoverProvider");
const errors_1 = require("../errors");
const downstreamTimeout_1 = require("./downstreamTimeout");
const ESCROW_GOVERNANCE_READ_ABI = [
    'function paused() view returns (bool)',
    'function claimsPaused() view returns (bool)',
    'function oracleActive() view returns (bool)',
    'function oracleAddress() view returns (address)',
    'function treasuryAddress() view returns (address)',
    'function treasuryPayoutAddress() view returns (address)',
    'function claimableUsdc(address account) view returns (uint256)',
    'function governanceApprovals() view returns (uint256)',
    'function governanceTimelock() view returns (uint256)',
    'function requiredApprovals() view returns (uint256)',
    'function hasActiveUnpauseProposal() view returns (bool)',
    'function unpauseHasApproved(address account) view returns (bool)',
    'function unpauseProposal() view returns (uint256 approvalCount, bool executed, uint256 createdAt, address proposer)',
    'function oracleUpdateCounter() view returns (uint256)',
    'function oracleUpdateHasApproved(uint256 proposalId, address account) view returns (bool)',
    'function oracleUpdateProposals(uint256 proposalId) view returns (address newOracle, uint256 approvalCount, bool executed, uint256 createdAt, uint256 eta, address proposer, bool emergencyFastTrack)',
    'function oracleUpdateProposalExpiresAt(uint256 proposalId) view returns (uint256)',
    'function oracleUpdateProposalCancelled(uint256 proposalId) view returns (bool)',
    'function treasuryPayoutAddressUpdateCounter() view returns (uint256)',
    'function treasuryPayoutAddressUpdateHasApproved(uint256 proposalId, address account) view returns (bool)',
    'function treasuryPayoutAddressUpdateProposals(uint256 proposalId) view returns (address newPayoutReceiver, uint256 approvalCount, bool executed, uint256 createdAt, uint256 eta, address proposer)',
    'function treasuryPayoutAddressUpdateProposalExpiresAt(uint256 proposalId) view returns (uint256)',
    'function treasuryPayoutAddressUpdateProposalCancelled(uint256 proposalId) view returns (bool)',
];
function toSafeInteger(value, field) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) {
        throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', `On-chain field '${field}' exceeds safe integer range`);
    }
    return numeric;
}
async function collectActiveProposalIds(candidateProposalIds, chainTimeSeconds, loadProposal, loadExpiry, loadCancelled) {
    const ids = [...new Set(candidateProposalIds)].map((proposalId) => BigInt(proposalId));
    const snapshots = await Promise.all(ids.map(async (proposalId) => {
        const [proposal, expiresAt, cancelled] = await Promise.all([
            loadProposal(proposalId),
            loadExpiry(proposalId),
            loadCancelled(proposalId),
        ]);
        const active = proposal.createdAt > 0n && !proposal.executed && !cancelled && expiresAt >= chainTimeSeconds;
        return active ? toSafeInteger(proposalId, 'proposalId') : null;
    }));
    return snapshots.filter((value) => value !== null);
}
class GovernanceStatusService {
    constructor(provider, contract, expectedChainId, rpcReadTimeoutMs) {
        this.provider = provider;
        this.contract = contract;
        this.expectedChainId = expectedChainId;
        this.rpcReadTimeoutMs = rpcReadTimeoutMs;
    }
    async checkReadiness() {
        const [network, paused] = await (0, downstreamTimeout_1.withTimeout)(Promise.all([
            this.provider.getNetwork(),
            this.contract.paused(),
        ]), this.rpcReadTimeoutMs, 'Timed out while probing governance RPC readiness', {
            details: {
                upstream: 'chain-rpc',
                operation: 'checkReadiness',
            },
        });
        if (Number(network.chainId) !== this.expectedChainId) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'RPC endpoint chain id does not match gateway configuration', {
                expectedChainId: this.expectedChainId,
                actualChainId: Number(network.chainId),
            });
        }
        if (typeof paused !== 'boolean') {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Escrow contract readiness probe returned invalid data');
        }
    }
    async getGovernanceStatus(request = {}) {
        try {
            const snapshot = await this.runChainRead('getGovernanceStatus.snapshot', Promise.all([
                this.contract.paused(),
                this.contract.claimsPaused(),
                this.contract.oracleActive(),
                this.contract.oracleAddress(),
                this.contract.treasuryAddress(),
                this.contract.treasuryPayoutAddress(),
                this.contract.governanceApprovals(),
                this.contract.governanceTimelock(),
                this.contract.requiredApprovals(),
                this.contract.hasActiveUnpauseProposal(),
                this.contract.unpauseProposal(),
            ]));
            const latestBlock = await this.runChainRead('getGovernanceStatus.latestBlock', this.provider.getBlock('latest'));
            const [paused, claimsPaused, oracleActive, oracleAddress, treasuryAddress, treasuryPayoutAddress, governanceApprovals, governanceTimelock, requiredApprovals, hasActiveUnpauseProposal, unpauseProposal,] = snapshot;
            const chainTimeSeconds = BigInt(latestBlock?.timestamp ?? 0);
            const [activeOracleProposalIds, activeTreasuryPayoutReceiverProposalIds,] = await this.runChainRead('getGovernanceStatus.activeProposals', Promise.all([
                collectActiveProposalIds(request.oracleProposalIds ?? [], chainTimeSeconds, (proposalId) => this.contract.oracleUpdateProposals(proposalId), (proposalId) => this.contract.oracleUpdateProposalExpiresAt(proposalId), (proposalId) => this.contract.oracleUpdateProposalCancelled(proposalId)),
                collectActiveProposalIds(request.treasuryPayoutReceiverProposalIds ?? [], chainTimeSeconds, (proposalId) => this.contract.treasuryPayoutAddressUpdateProposals(proposalId), (proposalId) => this.contract.treasuryPayoutAddressUpdateProposalExpiresAt(proposalId), (proposalId) => this.contract.treasuryPayoutAddressUpdateProposalCancelled(proposalId)),
            ]));
            return {
                paused,
                claimsPaused,
                oracleActive,
                oracleAddress,
                treasuryAddress,
                treasuryPayoutAddress,
                governanceApprovalsRequired: toSafeInteger(governanceApprovals, 'governanceApprovals'),
                governanceTimelockSeconds: toSafeInteger(governanceTimelock, 'governanceTimelock'),
                requiredAdminCount: toSafeInteger(requiredApprovals, 'requiredApprovals'),
                hasActiveUnpauseProposal,
                activeUnpauseApprovals: hasActiveUnpauseProposal ? toSafeInteger(unpauseProposal.approvalCount, 'unpauseProposal.approvalCount') : 0,
                activeOracleProposalIds,
                activeTreasuryPayoutReceiverProposalIds,
            };
        }
        catch (error) {
            if (error instanceof errors_1.GatewayError) {
                throw error;
            }
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read governance status from chain', {
                cause: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async getUnpauseProposalState() {
        try {
            const [hasActiveProposal, proposal] = await this.runChainRead('getUnpauseProposalState', Promise.all([
                this.contract.hasActiveUnpauseProposal(),
                this.contract.unpauseProposal(),
            ]));
            return {
                hasActiveProposal,
                approvalCount: hasActiveProposal ? toSafeInteger(proposal.approvalCount, 'unpauseProposal.approvalCount') : 0,
                executed: proposal.executed,
            };
        }
        catch (error) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read unpause proposal state', {
                cause: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async getOracleProposalState(proposalId) {
        try {
            const counter = toSafeInteger(await this.runChainRead('getOracleProposalState.counter', this.contract.oracleUpdateCounter()), 'oracleUpdateCounter');
            if (proposalId < 0 || proposalId >= counter) {
                return null;
            }
            const [proposal, expiresAt, cancelled] = await this.runChainRead('getOracleProposalState.proposal', Promise.all([
                this.contract.oracleUpdateProposals(BigInt(proposalId)),
                this.contract.oracleUpdateProposalExpiresAt(BigInt(proposalId)),
                this.contract.oracleUpdateProposalCancelled(BigInt(proposalId)),
            ]));
            if (proposal.createdAt <= 0n) {
                return null;
            }
            const expirySeconds = toSafeInteger(expiresAt, 'oracleUpdateProposalExpiresAt');
            return {
                proposalId,
                approvalCount: toSafeInteger(proposal.approvalCount, 'oracleUpdateProposal.approvalCount'),
                executed: proposal.executed,
                cancelled,
                expired: expirySeconds < Math.floor(Date.now() / 1000),
                etaSeconds: toSafeInteger(proposal.eta, 'oracleUpdateProposal.eta'),
                targetAddress: proposal.newOracle,
            };
        }
        catch (error) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read oracle proposal state', {
                cause: error instanceof Error ? error.message : String(error),
                proposalId,
            });
        }
    }
    async getTreasuryPayoutReceiverProposalState(proposalId) {
        try {
            const counter = toSafeInteger(await this.runChainRead('getTreasuryPayoutReceiverProposalState.counter', this.contract.treasuryPayoutAddressUpdateCounter()), 'treasuryPayoutAddressUpdateCounter');
            if (proposalId < 0 || proposalId >= counter) {
                return null;
            }
            const [proposal, expiresAt, cancelled] = await this.runChainRead('getTreasuryPayoutReceiverProposalState.proposal', Promise.all([
                this.contract.treasuryPayoutAddressUpdateProposals(BigInt(proposalId)),
                this.contract.treasuryPayoutAddressUpdateProposalExpiresAt(BigInt(proposalId)),
                this.contract.treasuryPayoutAddressUpdateProposalCancelled(BigInt(proposalId)),
            ]));
            if (proposal.createdAt <= 0n) {
                return null;
            }
            const expirySeconds = toSafeInteger(expiresAt, 'treasuryPayoutAddressUpdateProposalExpiresAt');
            return {
                proposalId,
                approvalCount: toSafeInteger(proposal.approvalCount, 'treasuryPayoutAddressUpdateProposal.approvalCount'),
                executed: proposal.executed,
                cancelled,
                expired: expirySeconds < Math.floor(Date.now() / 1000),
                etaSeconds: toSafeInteger(proposal.eta, 'treasuryPayoutAddressUpdateProposal.eta'),
                targetAddress: proposal.newPayoutReceiver,
            };
        }
        catch (error) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read treasury payout receiver proposal state', {
                cause: error instanceof Error ? error.message : String(error),
                proposalId,
            });
        }
    }
    async getTreasuryClaimableBalance() {
        try {
            const treasuryAddress = await this.runChainRead('getTreasuryClaimableBalance.address', this.contract.treasuryAddress());
            return await this.runChainRead('getTreasuryClaimableBalance.balance', this.contract.claimableUsdc(treasuryAddress));
        }
        catch (error) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read treasury claimable balance', {
                cause: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async hasApprovedUnpause(walletAddress) {
        try {
            return await this.runChainRead('hasApprovedUnpause', this.contract.unpauseHasApproved(walletAddress));
        }
        catch (error) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read unpause approval state', {
                cause: error instanceof Error ? error.message : String(error),
                walletAddress,
            });
        }
    }
    async hasApprovedOracleProposal(proposalId, walletAddress) {
        try {
            return await this.runChainRead('hasApprovedOracleProposal', this.contract.oracleUpdateHasApproved(BigInt(proposalId), walletAddress));
        }
        catch (error) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read oracle approval state', {
                cause: error instanceof Error ? error.message : String(error),
                proposalId,
                walletAddress,
            });
        }
    }
    async hasApprovedTreasuryPayoutReceiverProposal(proposalId, walletAddress) {
        try {
            return await this.runChainRead('hasApprovedTreasuryPayoutReceiverProposal', this.contract.treasuryPayoutAddressUpdateHasApproved(BigInt(proposalId), walletAddress));
        }
        catch (error) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read treasury payout receiver approval state', {
                cause: error instanceof Error ? error.message : String(error),
                proposalId,
                walletAddress,
            });
        }
    }
    async runChainRead(operation, promise) {
        return (0, downstreamTimeout_1.withTimeout)(promise, this.rpcReadTimeoutMs, 'Timed out while reading governance state from chain', {
            details: {
                upstream: 'chain-rpc',
                operation,
            },
        });
    }
}
exports.GovernanceStatusService = GovernanceStatusService;
function createGovernanceStatusService(config) {
    const provider = (0, failoverProvider_1.createManagedRpcProvider)(config.rpcUrl, config.rpcFallbackUrls, {
        chainId: config.chainId,
        stallTimeoutMs: Math.max(250, Math.floor(config.rpcReadTimeoutMs / 2)),
    });
    const contract = new ethers_1.Contract(config.escrowAddress, ESCROW_GOVERNANCE_READ_ABI, provider);
    return new GovernanceStatusService(provider, contract, config.chainId, config.rpcReadTimeoutMs);
}
//# sourceMappingURL=governanceStatusService.js.map