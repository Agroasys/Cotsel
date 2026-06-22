/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AbstractProvider, Contract } from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';
import { withTimeout } from './downstreamTimeout';

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
  getGovernanceStatus(): Promise<GovernanceStatusSnapshot>;
}

export interface GovernanceMutationPreflightReader extends EscrowGovernanceReader {
  getUnpauseProposalState(): Promise<UnpauseProposalState>;
  getOracleProposalState(proposalId: number): Promise<GovernanceProposalState | null>;
  getTreasuryPayoutReceiverProposalState(
    proposalId: number,
  ): Promise<GovernanceProposalState | null>;
  getTreasuryClaimableBalance(): Promise<bigint>;
  hasApprovedUnpause(walletAddress: string): Promise<boolean>;
  hasApprovedOracleProposal(proposalId: number, walletAddress: string): Promise<boolean>;
  hasApprovedTreasuryPayoutReceiverProposal(
    proposalId: number,
    walletAddress: string,
  ): Promise<boolean>;
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
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      `On-chain field '${field}' exceeds safe integer range`,
    );
  }

  return numeric;
}

// Hard upper bound on how many of the most-recent proposal IDs a single
// governance-status read will scan. Proposal IDs are minted sequentially
// on-chain (0..counter-1) and older entries necessarily resolve (execute,
// cancel, or expire), so active proposals cluster at the high end of the range.
// Bounding the scan keeps one dashboard read from fanning out an unbounded
// number of RPC calls as the on-chain counters grow.
const MAX_ACTIVE_PROPOSAL_SCAN = 256;

// Cap on how many proposal IDs are read from the RPC provider at once, so even
// a full-window scan issues a bounded number of simultaneous calls rather than
// firing the entire window in parallel.
const PROPOSAL_SCAN_CONCURRENCY = 16;

// Enumerate the most-recent window of sequentially minted proposal IDs and keep
// only the entries the contract still reports as active, so the gateway needs no
// off-chain mirror of governance proposals. Anything older than the window is
// treated as inactive (degraded behavior, surfaced via a warning log) because a
// sequential proposal that old has necessarily resolved or expired.
async function collectActiveProposalIds(
  proposalSet: string,
  proposalCounter: bigint,
  chainTimeSeconds: bigint,
  loadProposal: (proposalId: bigint) => Promise<{ createdAt: bigint; executed: boolean }>,
  loadExpiry: (proposalId: bigint) => Promise<bigint>,
  loadCancelled: (proposalId: bigint) => Promise<boolean>,
): Promise<number[]> {
  const windowSize = BigInt(MAX_ACTIVE_PROPOSAL_SCAN);
  const windowStart = proposalCounter > windowSize ? proposalCounter - windowSize : 0n;

  if (windowStart > 0n) {
    Logger.warn('Governance proposal scan truncated to most-recent window', {
      proposalSet,
      proposalCounter: proposalCounter.toString(),
      scannedFromId: windowStart.toString(),
      windowSize: MAX_ACTIVE_PROPOSAL_SCAN,
    });
  }

  const ids: bigint[] = [];
  for (let id = windowStart; id < proposalCounter; id += 1n) {
    ids.push(id);
  }

  const active: number[] = [];
  for (let offset = 0; offset < ids.length; offset += PROPOSAL_SCAN_CONCURRENCY) {
    const snapshots = await Promise.all(
      ids.slice(offset, offset + PROPOSAL_SCAN_CONCURRENCY).map(async (proposalId) => {
        const [proposal, expiresAt, cancelled] = await Promise.all([
          loadProposal(proposalId),
          loadExpiry(proposalId),
          loadCancelled(proposalId),
        ]);

        const isActive =
          proposal.createdAt > 0n &&
          !proposal.executed &&
          !cancelled &&
          expiresAt >= chainTimeSeconds;
        return isActive ? toSafeInteger(proposalId, 'proposalId') : null;
      }),
    );

    for (const value of snapshots) {
      if (value !== null) {
        active.push(value);
      }
    }
  }

  return active;
}

export class GovernanceStatusService implements GovernanceMutationPreflightReader {
  constructor(
    private readonly provider: AbstractProvider,
    private readonly contract: GovernanceContractShape,
    private readonly expectedChainId: number,
    private readonly rpcReadTimeoutMs: number,
  ) {}

  async checkReadiness(): Promise<void> {
    const [network, paused] = await withTimeout(
      Promise.all([this.provider.getNetwork(), this.contract.paused()]),
      this.rpcReadTimeoutMs,
      'Timed out while probing governance RPC readiness',
      {
        details: {
          upstream: 'chain-rpc',
          operation: 'checkReadiness',
        },
      },
    );

    if (Number(network.chainId) !== this.expectedChainId) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'RPC endpoint chain id does not match gateway configuration',
        {
          expectedChainId: this.expectedChainId,
          actualChainId: Number(network.chainId),
        },
      );
    }

    if (typeof paused !== 'boolean') {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Escrow contract readiness probe returned invalid data',
      );
    }
  }

  async getGovernanceStatus(): Promise<GovernanceStatusSnapshot> {
    try {
      const snapshot = await this.runChainRead(
        'getGovernanceStatus.snapshot',
        Promise.all([
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
          this.contract.oracleUpdateCounter(),
          this.contract.treasuryPayoutAddressUpdateCounter(),
        ] as const),
      );
      const latestBlock = await this.runChainRead(
        'getGovernanceStatus.latestBlock',
        this.provider.getBlock('latest'),
      );
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
        oracleUpdateCounter,
        treasuryPayoutAddressUpdateCounter,
      ] = snapshot;

      const chainTimeSeconds = BigInt(latestBlock?.timestamp ?? 0);

      const [activeOracleProposalIds, activeTreasuryPayoutReceiverProposalIds] =
        await this.runChainRead(
          'getGovernanceStatus.activeProposals',
          Promise.all([
            collectActiveProposalIds(
              'oracleUpdate',
              oracleUpdateCounter,
              chainTimeSeconds,
              (proposalId) => this.contract.oracleUpdateProposals(proposalId),
              (proposalId) => this.contract.oracleUpdateProposalExpiresAt(proposalId),
              (proposalId) => this.contract.oracleUpdateProposalCancelled(proposalId),
            ),
            collectActiveProposalIds(
              'treasuryPayoutAddressUpdate',
              treasuryPayoutAddressUpdateCounter,
              chainTimeSeconds,
              (proposalId) => this.contract.treasuryPayoutAddressUpdateProposals(proposalId),
              (proposalId) =>
                this.contract.treasuryPayoutAddressUpdateProposalExpiresAt(proposalId),
              (proposalId) =>
                this.contract.treasuryPayoutAddressUpdateProposalCancelled(proposalId),
            ),
          ]),
        );

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
        activeUnpauseApprovals: hasActiveUnpauseProposal
          ? toSafeInteger(unpauseProposal.approvalCount, 'unpauseProposal.approvalCount')
          : 0,
        activeOracleProposalIds,
        activeTreasuryPayoutReceiverProposalIds,
      };
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }

      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Failed to read governance status from chain',
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async getUnpauseProposalState(): Promise<UnpauseProposalState> {
    try {
      const [hasActiveProposal, proposal] = await this.runChainRead(
        'getUnpauseProposalState',
        Promise.all([this.contract.hasActiveUnpauseProposal(), this.contract.unpauseProposal()]),
      );

      return {
        hasActiveProposal,
        approvalCount: hasActiveProposal
          ? toSafeInteger(proposal.approvalCount, 'unpauseProposal.approvalCount')
          : 0,
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
      const counter = toSafeInteger(
        await this.runChainRead(
          'getOracleProposalState.counter',
          this.contract.oracleUpdateCounter(),
        ),
        'oracleUpdateCounter',
      );
      if (proposalId < 0 || proposalId >= counter) {
        return null;
      }

      const [proposal, expiresAt, cancelled] = await this.runChainRead(
        'getOracleProposalState.proposal',
        Promise.all([
          this.contract.oracleUpdateProposals(BigInt(proposalId)),
          this.contract.oracleUpdateProposalExpiresAt(BigInt(proposalId)),
          this.contract.oracleUpdateProposalCancelled(BigInt(proposalId)),
        ]),
      );

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

  async getTreasuryPayoutReceiverProposalState(
    proposalId: number,
  ): Promise<GovernanceProposalState | null> {
    try {
      const counter = toSafeInteger(
        await this.runChainRead(
          'getTreasuryPayoutReceiverProposalState.counter',
          this.contract.treasuryPayoutAddressUpdateCounter(),
        ),
        'treasuryPayoutAddressUpdateCounter',
      );
      if (proposalId < 0 || proposalId >= counter) {
        return null;
      }

      const [proposal, expiresAt, cancelled] = await this.runChainRead(
        'getTreasuryPayoutReceiverProposalState.proposal',
        Promise.all([
          this.contract.treasuryPayoutAddressUpdateProposals(BigInt(proposalId)),
          this.contract.treasuryPayoutAddressUpdateProposalExpiresAt(BigInt(proposalId)),
          this.contract.treasuryPayoutAddressUpdateProposalCancelled(BigInt(proposalId)),
        ]),
      );

      if (proposal.createdAt <= 0n) {
        return null;
      }

      const expirySeconds = toSafeInteger(
        expiresAt,
        'treasuryPayoutAddressUpdateProposalExpiresAt',
      );
      return {
        proposalId,
        approvalCount: toSafeInteger(
          proposal.approvalCount,
          'treasuryPayoutAddressUpdateProposal.approvalCount',
        ),
        executed: proposal.executed,
        cancelled,
        expired: expirySeconds < Math.floor(Date.now() / 1000),
        etaSeconds: toSafeInteger(proposal.eta, 'treasuryPayoutAddressUpdateProposal.eta'),
        targetAddress: proposal.newPayoutReceiver,
      };
    } catch (error) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Failed to read treasury payout receiver proposal state',
        {
          cause: error instanceof Error ? error.message : String(error),
          proposalId,
        },
      );
    }
  }

  async getTreasuryClaimableBalance(): Promise<bigint> {
    try {
      const treasuryAddress = await this.runChainRead(
        'getTreasuryClaimableBalance.address',
        this.contract.treasuryAddress(),
      );
      return await this.runChainRead(
        'getTreasuryClaimableBalance.balance',
        this.contract.claimableUsdc(treasuryAddress),
      );
    } catch (error) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Failed to read treasury claimable balance',
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async hasApprovedUnpause(walletAddress: string): Promise<boolean> {
    try {
      return await this.runChainRead(
        'hasApprovedUnpause',
        this.contract.unpauseHasApproved(walletAddress),
      );
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read unpause approval state', {
        cause: error instanceof Error ? error.message : String(error),
        walletAddress,
      });
    }
  }

  async hasApprovedOracleProposal(proposalId: number, walletAddress: string): Promise<boolean> {
    try {
      return await this.runChainRead(
        'hasApprovedOracleProposal',
        this.contract.oracleUpdateHasApproved(BigInt(proposalId), walletAddress),
      );
    } catch (error) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed to read oracle approval state', {
        cause: error instanceof Error ? error.message : String(error),
        proposalId,
        walletAddress,
      });
    }
  }

  async hasApprovedTreasuryPayoutReceiverProposal(
    proposalId: number,
    walletAddress: string,
  ): Promise<boolean> {
    try {
      return await this.runChainRead(
        'hasApprovedTreasuryPayoutReceiverProposal',
        this.contract.treasuryPayoutAddressUpdateHasApproved(BigInt(proposalId), walletAddress),
      );
    } catch (error) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Failed to read treasury payout receiver approval state',
        {
          cause: error instanceof Error ? error.message : String(error),
          proposalId,
          walletAddress,
        },
      );
    }
  }

  private async runChainRead<T>(operation: string, promise: Promise<T>): Promise<T> {
    return withTimeout(
      promise,
      this.rpcReadTimeoutMs,
      'Timed out while reading governance state from chain',
      {
        details: {
          upstream: 'chain-rpc',
          operation,
        },
      },
    );
  }
}

export function createGovernanceStatusService(config: GatewayConfig): GovernanceStatusService {
  const provider = createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
    chainId: config.chainId,
    stallTimeoutMs: Math.max(250, Math.floor(config.rpcReadTimeoutMs / 2)),
  });
  const contract = new Contract(
    config.escrowAddress,
    ESCROW_GOVERNANCE_READ_ABI,
    provider,
  ) as unknown as GovernanceContractShape;
  return new GovernanceStatusService(provider, contract, config.chainId, config.rpcReadTimeoutMs);
}
