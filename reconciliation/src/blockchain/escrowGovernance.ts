import { AgroasysEscrow__factory, createManagedRpcProvider } from '@agroasys/sdk';
import { ethers, type AbstractProvider } from 'ethers';
import { config } from '../config';
import { GovernedApprovalError } from '../core/governedApproval';
import type {
  ApprovalLog,
  GovernedUnpauseFacts,
  OnchainUnpauseProposal,
  UnpauseLog,
} from '../core/governedApproval';

/**
 * The escrow's control-plane read surface: the scoped pause, and the governance
 * decision that lifts it.
 *
 * Kept apart from `OnchainClient`, which is the coverage comparison's read
 * surface. These reads answer "is this trade contained on chain, and who said
 * it may resume" — a different question from "what does the chain say this
 * trade is", and one that needs the contract's own logs rather than trade
 * state.
 */
export class EscrowGovernanceReader {
  private readonly provider: AbstractProvider;
  private readonly contract: ReturnType<typeof AgroasysEscrow__factory.connect>;
  private readonly escrowInterface = AgroasysEscrow__factory.createInterface();

  constructor() {
    this.provider = createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
      chainId: config.chainId,
      quorum: config.rpcQuorum,
      stallTimeoutMs: config.rpcStallTimeoutMs,
    });
    this.contract = AgroasysEscrow__factory.connect(config.escrowAddress, this.provider);
  }

  /**
   * Whether the escrow's own scoped pause is applied to this trade.
   *
   * Read at the run's boundary block rather than the head, so the answer sits
   * at the same height as everything else the run concluded and cannot be
   * changed underneath it by a re-org.
   */
  async isTradePaused(tradeId: string, blockTag: number): Promise<boolean> {
    return this.contract.tradePaused(BigInt(tradeId), { blockTag });
  }

  /**
   * Gather everything a candidate approval transaction can be judged on.
   *
   * The proposal is read back at the transaction's own block: `_executeUnpause`
   * marks the slot executed without clearing it, so at that height the escrow
   * still states which scope, trade and incident reference the quorum acted on.
   * Reading it at the head instead would see whatever proposal came next.
   */
  async readGovernedUnpause(txHash: string): Promise<GovernedUnpauseFacts> {
    const network = await this.provider.getNetwork();
    const chainId = Number(network.chainId);
    if (chainId !== config.chainId) {
      throw new GovernedApprovalError(
        `Connected to chain ${chainId} but this deployment settles on ${config.chainId}; refusing ` +
          'to read an approval from the wrong chain',
      );
    }

    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return {
        txHash,
        chainId,
        escrowAddress: config.escrowAddress,
        receiptStatus: null,
        blockNumber: 0,
        blockHash: '',
        blockTimestamp: 0,
        finalityBlockNumber: 0,
        unpausedLogs: [],
        approvalLogs: [],
        proposal: { scope: -1, tradeId: '', incidentRef: '', approvalCount: 0, executed: false },
      };
    }

    const [block, finalityBlock] = await Promise.all([
      this.provider.getBlock(receipt.blockNumber),
      this.provider.getBlock(config.coverageBoundary),
    ]);

    if (!block) {
      throw new GovernedApprovalError(
        `Block ${receipt.blockNumber} carrying ${txHash} could not be read back`,
      );
    }

    const unpausedLogs: UnpauseLog[] = [];
    const approvalLogs: ApprovalLog[] = [];

    for (const log of receipt.logs) {
      const parsed = this.parse(log);
      if (!parsed) {
        continue;
      }

      if (parsed.name === 'TradeUnpaused') {
        unpausedLogs.push({
          address: log.address,
          tradeId: (parsed.args.tradeId as bigint).toString(),
          logIndex: log.index,
        });
      } else if (parsed.name === 'UnpauseApproved') {
        approvalLogs.push({
          address: log.address,
          approver: ethers.getAddress(parsed.args.approver as string),
          approvalCount: Number(parsed.args.approvalCount as bigint),
          requiredApprovals: Number(parsed.args.requiredApprovals as bigint),
          logIndex: log.index,
        });
      }
    }

    return {
      txHash,
      chainId,
      escrowAddress: config.escrowAddress,
      receiptStatus: receipt.status ?? null,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTimestamp: block.timestamp,
      finalityBlockNumber: finalityBlock?.number ?? 0,
      unpausedLogs,
      approvalLogs,
      proposal: await this.readProposalAt(receipt.blockNumber),
    };
  }

  private async readProposalAt(blockTag: number): Promise<OnchainUnpauseProposal> {
    const proposal = await this.contract.unpauseProposal({ blockTag });

    return {
      scope: Number(proposal.scope),
      tradeId: proposal.tradeId.toString(),
      incidentRef: proposal.incidentRef,
      approvalCount: Number(proposal.approvalCount),
      executed: proposal.executed,
    };
  }

  /** A log this ABI does not describe is another contract's; skip it. */
  private parse(log: { topics: readonly string[]; data: string }): ethers.LogDescription | null {
    try {
      return this.escrowInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      return null;
    }
  }
}
