/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Contract, JsonRpcProvider } from 'ethers';
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';

export interface GovernanceStatusSnapshot {
  paused: boolean;
  claimsPaused: boolean;
  oracleActive: boolean;
  oracleAddress: string;
  treasuryAddress: string;
  treasuryPayoutAddress: string;
  governanceApprovalsRequired: number;
  governanceTimelockSeconds: number;
  requiredAdminCount: number;
  hasActiveUnpauseProposal: boolean;
  activeUnpauseApprovals: number;
  activeOracleProposalIds: number[];
  activeTreasuryPayoutReceiverProposalIds: number[];
}

export interface UnpauseProposalState {
  hasActiveProposal: boolean;
  approvalCount: number;
  executed: boolean;
}

export interface GovernanceProposalState {
  proposalId: number;
  approvalCount: number;
  executed: boolean;
  cancelled: boolean;
  expired: boolean;
  etaSeconds: number;
  targetAddress: string;
}

export interface GovernanceStatusRequest {
  oracleProposalIds?: number[];
  treasuryPayoutReceiverProposalIds?: number[];
}

interface UnpauseProposal {
  approvalCount: bigint;
  executed: boolean;
  createdAt: bigint;
  proposer: string;
}

interface OracleUpdateProposal {
  newOracle: string;
  approvalCount: bigint;
  executed: boolean;
  createdAt: bigint;
  eta: bigint;
  proposer: string;
  emergencyFastTrack: boolean;
}

interface TreasuryPayoutReceiverProposal {
  newPayoutReceiver: string;
  approvalCount: bigint;
  executed: boolean;
  createdAt: bigint;
  eta: bigint;
  proposer: string;
}

export interface EscrowGovernanceReader {
  checkReadiness(): Promise<void>;
  getGovernanceStatus(request?: GovernanceStatusRequest): Promise<GovernanceStatusSnapshot>;
}

export interface GovernanceMutationPreflightReader extends EscrowGovernanceReader {
  getUnpauseProposalState(): Promise<UnpauseProposalState>;
  getOracleProposalState(proposalId: number): Promise<GovernanceProposalState | null>;
  getTreasuryPayoutReceiverProposalState(proposalId: number): Promise<GovernanceProposalState | null>;
  getTreasuryClaimableBalance(): Promise<bigint>;
  hasApprovedUnpause(walletAddress: string): Promise<boolean>;
  hasApprovedOracleProposal(proposalId: number, walletAddress: string): Promise<boolean>;
  hasApprovedTreasuryPayoutReceiverProposal(proposalId: number, walletAddress: string): Promise<boolean>;
}

type GovernanceContractShape = {
  paused(): Promise<boolean>;
  claimsPaused(): Promise<boolean>;
  oracleActive(): Promise<boolean>;
  oracleAddress(): Promise<string>;
  treasuryAddress(): Promise<string>;
  treasuryPayoutAddress(): Promise<string>;
  claimableUsdc(account: string): Promise<bigint>;
  governanceApprovals(): Promise<bigint>;
  governanceTimelock(): Promise<bigint>;
  requiredApprovals(): Promise<bigint>;
  hasActiveUnpauseProposal(): Promise<boolean>;
  unpauseHasApproved(account: string): Promise<boolean>;
  unpauseProposal(): Promise<UnpauseProposal>;
  oracleUpdateCounter(): Promise<bigint>;
  oracleUpdateHasApproved(id: bigint, account: string): Promise<boolean>;
  oracleUpdateProposals(id: bigint): Promise<OracleUpdateProposal>;
  oracleUpdateProposalExpiresAt(id: bigint): Promise<bigint>;
  oracleUpdateProposalCancelled(id: bigint): Promise<boolean>;
  treasuryPayoutAddressUpdateCounter(): Promise<bigint>;
  treasuryPayoutAddressUpdateHasApproved(id: bigint, account: string): Promise<boolean>;
  treasuryPayoutAddressUpdateProposals(id: bigint): Promise<TreasuryPayoutReceiverProposal>;
  treasuryPayoutAddressUpdateProposalExpiresAt(id: bigint): Promise<bigint>;
  treasuryPayoutAddressUpdateProposalCancelled(id: bigint): Promise<boolean>;
};

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
] as const;

function toSafeInteger(value: bigint, field: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', `On-chain field '${field}' exceeds safe integer range`);
  }

  return numeric;
}

async function collectActiveProposalIds(
  candidateProposalIds: number[],
  chainTimeSeconds: bigint,
  loadProposal: (proposalId: bigint) => Promise<{ createdAt: bigint; executed: boolean }>,
  loadExpiry: (proposalId: bigint) => Promise<bigint>,
  loadCancelled: (proposalId: bigint) => Promise<boolean>,
): Promise<number[]> {
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

  return snapshots.filter((value): value is number => value !== null);
}

export class GovernanceStatusService implements GovernanceMutationPreflightReader {
  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly contract: GovernanceContractShape,
    private readonly expectedChainId: number,
  ) {}

  async checkReadiness(): Promise<void> {
    const [network, paused] = await Promise.all([
      this.provider.getNetwork(),
      this.contract.paused(),
    ]);

    if (Number(network.chainId) !== this.expectedChainId) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'RPC endpoint chain id does not match gateway configuration', {
        expectedChainId: this.expectedChainId,
        actualChainId: Number(network.chainId),
      });
    }

    if (typeof paused !== 'boolean') {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Escrow contract readiness probe returned invalid data');
    }
  }

  async getGovernanceStatus(request: GovernanceStatusRequest = {}): Promise<GovernanceStatusSnapshot> {
    try {
      const [
        paused,
        claimsPaused,
        oracleActive,
        oracleAddress,
        treasuryAddress,
        treasuryPayoutAddress,
        governanceApprovals,
        governanceTimelock,
        requiredApprovals,
        hasActiveUnpauseProposal,
        unpauseProposal,
        latestBlock,
      ] = await Promise.all([
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
        this.provider.getBlock('latest'),
      ]);

      const chainTimeSeconds = BigInt(latestBlock?.timestamp ?? 0);

      const [
        activeOracleProposalIds,
        activeTreasuryPayoutReceiverProposalIds,
      ] = await Promise.all([
        collectActiveProposalIds(
          request.oracleProposalIds ?? [],
          chainTimeSeconds,
          (proposalId) => this.contract.oracleUpdateProposals(proposalId),
          (proposalId) => this.contract.oracleUpdateProposalExpiresAt(proposalId),
          (proposalId) => this.contract.oracleUpdateProposalCancelled(proposalId),
        ),
        collectActiveProposalIds(
          request.treasuryPayoutReceiverProposalIds ?? [],
          chainTimeSeconds,
          (proposalId) => this.contract.treasuryPayoutAddressUpdateProposals(proposalId),
          (proposalId) => this.contract.treasuryPayoutAddressUpdateProposalExpiresAt(proposalId),
          (proposalId) => this.contract.treasuryPayoutAddressUpdateProposalCancelled(proposalId),
        ),
      ]);

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
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }

      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read governance status from chain', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getUnpauseProposalState(): Promise<UnpauseProposalState> {
    try {
      const [hasActiveProposal, proposal] = await Promise.all([
        this.contract.hasActiveUnpauseProposal(),
        this.contract.unpauseProposal(),
      ]);

      return {
        hasActiveProposal,
        approvalCount: hasActiveProposal ? toSafeInteger(proposal.approvalCount, 'unpauseProposal.approvalCount') : 0,
        executed: proposal.executed,
      };
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read unpause proposal state', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getOracleProposalState(proposalId: number): Promise<GovernanceProposalState | null> {
    try {
      const counter = toSafeInteger(await this.contract.oracleUpdateCounter(), 'oracleUpdateCounter');
      if (proposalId < 0 || proposalId >= counter) {
        return null;
      }

      const [proposal, expiresAt, cancelled] = await Promise.all([
        this.contract.oracleUpdateProposals(BigInt(proposalId)),
        this.contract.oracleUpdateProposalExpiresAt(BigInt(proposalId)),
        this.contract.oracleUpdateProposalCancelled(BigInt(proposalId)),
      ]);

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
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read oracle proposal state', {
        cause: error instanceof Error ? error.message : String(error),
        proposalId,
      });
    }
  }

  async getTreasuryPayoutReceiverProposalState(proposalId: number): Promise<GovernanceProposalState | null> {
    try {
      const counter = toSafeInteger(await this.contract.treasuryPayoutAddressUpdateCounter(), 'treasuryPayoutAddressUpdateCounter');
      if (proposalId < 0 || proposalId >= counter) {
        return null;
      }

      const [proposal, expiresAt, cancelled] = await Promise.all([
        this.contract.treasuryPayoutAddressUpdateProposals(BigInt(proposalId)),
        this.contract.treasuryPayoutAddressUpdateProposalExpiresAt(BigInt(proposalId)),
        this.contract.treasuryPayoutAddressUpdateProposalCancelled(BigInt(proposalId)),
      ]);

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
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read treasury payout receiver proposal state', {
        cause: error instanceof Error ? error.message : String(error),
        proposalId,
      });
    }
  }

  async getTreasuryClaimableBalance(): Promise<bigint> {
    try {
      const treasuryAddress = await this.contract.treasuryAddress();
      return await this.contract.claimableUsdc(treasuryAddress);
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read treasury claimable balance', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async hasApprovedUnpause(walletAddress: string): Promise<boolean> {
    try {
      return await this.contract.unpauseHasApproved(walletAddress);
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read unpause approval state', {
        cause: error instanceof Error ? error.message : String(error),
        walletAddress,
      });
    }
  }

  async hasApprovedOracleProposal(proposalId: number, walletAddress: string): Promise<boolean> {
    try {
      return await this.contract.oracleUpdateHasApproved(BigInt(proposalId), walletAddress);
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read oracle approval state', {
        cause: error instanceof Error ? error.message : String(error),
        proposalId,
        walletAddress,
      });
    }
  }

  async hasApprovedTreasuryPayoutReceiverProposal(proposalId: number, walletAddress: string): Promise<boolean> {
    try {
      return await this.contract.treasuryPayoutAddressUpdateHasApproved(BigInt(proposalId), walletAddress);
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read treasury payout receiver approval state', {
        cause: error instanceof Error ? error.message : String(error),
        proposalId,
        walletAddress,
      });
    }
  }
}

export function createGovernanceStatusService(config: GatewayConfig): GovernanceStatusService {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const contract = new Contract(config.escrowAddress, ESCROW_GOVERNANCE_READ_ABI, provider) as unknown as GovernanceContractShape;
  return new GovernanceStatusService(provider, contract, config.chainId);
}
