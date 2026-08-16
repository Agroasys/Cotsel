/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client } from '../client';
import { ethers } from 'ethers';
import { DisputeStatus, DisputeProposalResult, DisputeResult } from '../types/dispute';
import {
  AdminChangeKind,
  GovernanceProposalResult,
  GovernanceResult,
  PauseScope,
} from '../types/governance';
import {
  AuthorizationError,
  ContractError,
  getErrorMessage,
  ValidationError,
} from '../types/errors';
import { validateAddress } from '../utils/validation';

export class AdminSDK extends Client {
  private async verifyAdmin(adminSigner: ethers.Signer): Promise<void> {
    await this.assertSignerCompatibility(adminSigner, 'Admin signer');

    const adminAddress = await adminSigner.getAddress();
    const isAdmin = await this.isAdmin(adminAddress);

    if (!isAdmin) {
      throw new AuthorizationError('Caller is not an authorized admin', { address: adminAddress });
    }
  }

  private extractProposalIdFromReceipt(
    receipt: ethers.TransactionReceipt,
    expectedEventName: string,
  ): bigint | undefined {
    const logs = receipt.logs;
    const contractInterface = this.contract.interface;
    if (!contractInterface) {
      return undefined;
    }

    for (const log of logs) {
      try {
        const parsedLog = contractInterface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (!parsedLog || parsedLog.name !== expectedEventName) {
          continue;
        }

        const proposalId = parsedLog.args?.proposalId;
        if (typeof proposalId === 'bigint') {
          return proposalId;
        }
        if (proposalId !== undefined && proposalId !== null) {
          return BigInt(proposalId.toString());
        }
      } catch {
        // Ignore non-contract logs.
      }
    }
    return undefined;
  }

  // #################### SYSTEM CONTROL ####################

  async pause(adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.pause();
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to pause protocol: ${message}`, {
        error: message,
      });
    }
  }

  async proposeUnpause(
    scope: PauseScope,
    tradeId: bigint,
    incidentRef: string,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);
    if (!ethers.isHexString(incidentRef, 32) || incidentRef === ethers.ZeroHash) {
      throw new ValidationError('incidentRef must be a non-zero bytes32 incident reference');
    }
    if (scope !== PauseScope.TRADE && tradeId !== 0n) {
      throw new ValidationError('tradeId must be zero unless the trade pause scope is selected');
    }

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.proposeUnpause(scope, tradeId, incidentRef);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to propose unpause: ${message}`, {
        error: message,
      });
    }
  }

  async proposeGlobalUnpause(
    incidentRef: string,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    return this.proposeUnpause(PauseScope.GLOBAL, 0n, incidentRef, adminSigner);
  }

  async proposeClaimsUnpause(
    incidentRef: string,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    return this.proposeUnpause(PauseScope.CLAIMS, 0n, incidentRef, adminSigner);
  }

  async proposeTradeUnpause(
    tradeId: bigint,
    incidentRef: string,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    return this.proposeUnpause(PauseScope.TRADE, tradeId, incidentRef, adminSigner);
  }

  async approveUnpause(adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.approveUnpause();
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to approve unpause: ${message}`, {
        error: message,
      });
    }
  }

  async cancelUnpauseProposal(adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.cancelUnpauseProposal();
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to cancel unpause proposal: ${message}`, {
        error: message,
      });
    }
  }

  async disableOracleEmergency(adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.disableOracleEmergency();
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to disable oracle: ${message}`, {
        error: message,
      });
    }
  }

  async pauseClaims(adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.pauseClaims();
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to pause claims: ${message}`, { error: message });
    }
  }

  /**
   * Pauses lifecycle transitions for a single trade, scoped to one tradeId. Same intent
   * as the global pause but leaves every other trade unaffected.
   */
  async pauseTrade(tradeId: bigint, adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.pauseTrade(tradeId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to pause trade: ${message}`, { error: message });
    }
  }

  async claimTreasury(triggerSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.assertSignerCompatibility(triggerSigner);

    try {
      const contractWithSigner = this.contract.connect(triggerSigner);
      const tx = await contractWithSigner.claimTreasury();
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to claim treasury: ${message}`, {
        error: message,
      });
    }
  }

  async proposeTreasuryPayoutAddressUpdate(
    newPayoutReceiver: string,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceProposalResult> {
    await this.verifyAdmin(adminSigner);
    validateAddress(newPayoutReceiver, 'newPayoutReceiver');

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.proposeTreasuryPayoutAddressUpdate(newPayoutReceiver);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        proposalId: this.extractProposalIdFromReceipt(
          receipt,
          'TreasuryPayoutAddressUpdateProposed',
        ),
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to propose treasury payout receiver update: ${message}`, {
        newPayoutReceiver,
        error: message,
      });
    }
  }

  async approveTreasuryPayoutAddressUpdate(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.approveTreasuryPayoutAddressUpdate(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to approve treasury payout receiver update: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async executeTreasuryPayoutAddressUpdate(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.executeTreasuryPayoutAddressUpdate(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to execute treasury payout receiver update: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async cancelExpiredTreasuryPayoutAddressUpdateProposal(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx =
        await contractWithSigner.cancelExpiredTreasuryPayoutAddressUpdateProposal(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(
        `Failed to cancel expired treasury payout receiver update proposal: ${message}`,
        { proposalId: proposalId.toString(), error: message },
      );
    }
  }

  // #################### DISPUTE RESOLUTION ####################

  async proposeDisputeSolution(
    tradeId: string | bigint,
    disputeStatus: DisputeStatus,
    adminSigner: ethers.Signer,
  ): Promise<DisputeProposalResult> {
    await this.verifyAdmin(adminSigner);

    if (disputeStatus !== DisputeStatus.REFUND && disputeStatus !== DisputeStatus.RESOLVE) {
      throw new ValidationError('Invalid dispute status', { disputeStatus });
    }

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.proposeDisputeSolution(tradeId, disputeStatus);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        proposalId: this.extractProposalIdFromReceipt(receipt, 'DisputeSolutionProposed'),
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to propose dispute solution: ${message}`, {
        tradeId: tradeId.toString(),
        disputeStatus,
        error: message,
      });
    }
  }

  async approveDisputeSolution(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<DisputeResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.approveDisputeSolution(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to approve dispute solution: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async cancelExpiredDisputeProposal(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<DisputeResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.cancelExpiredDisputeProposal(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to cancel expired dispute proposal: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  // #################### ORACLE GOVERNANCE ####################

  async proposeOracleUpdate(
    newOracle: string,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceProposalResult> {
    await this.verifyAdmin(adminSigner);
    validateAddress(newOracle, 'newOracle');

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.proposeOracleUpdate(newOracle);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        proposalId: this.extractProposalIdFromReceipt(receipt, 'OracleUpdateProposed'),
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to propose oracle update: ${message}`, {
        newOracle,
        error: message,
      });
    }
  }

  async approveOracleUpdate(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.approveOracleUpdate(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to approve oracle update: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async executeOracleUpdate(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.executeOracleUpdate(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to execute oracle update: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async cancelExpiredOracleUpdateProposal(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.cancelExpiredOracleUpdateProposal(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to cancel expired oracle update proposal: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  // #################### ADMIN GOVERNANCE ####################

  async proposeAdminChange(
    kind: AdminChangeKind,
    currentAdmin: string,
    newAdmin: string,
    newThreshold: bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceProposalResult> {
    await this.verifyAdmin(adminSigner);
    if (
      kind === AdminChangeKind.ADD ||
      kind === AdminChangeKind.REPLACE ||
      kind === AdminChangeKind.RELAYER_ADD
    ) {
      validateAddress(newAdmin, 'newAdmin');
    }
    if (
      kind === AdminChangeKind.REMOVE ||
      kind === AdminChangeKind.REPLACE ||
      kind === AdminChangeKind.RELAYER_REMOVE
    ) {
      validateAddress(currentAdmin, 'currentAdmin');
    }

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.proposeAdminChange(
        kind,
        currentAdmin,
        newAdmin,
        newThreshold,
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        proposalId: this.extractProposalIdFromReceipt(receipt, 'AdminChangeProposed'),
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to propose governed role change: ${message}`, {
        kind,
        currentAdmin,
        newAdmin,
        newThreshold: newThreshold.toString(),
        error: message,
      });
    }
  }

  async proposeAddAdmin(newAdmin: string, adminSigner: ethers.Signer) {
    return this.proposeAdminChange(
      AdminChangeKind.ADD,
      ethers.ZeroAddress,
      newAdmin,
      0n,
      adminSigner,
    );
  }

  async proposeRemoveAdmin(currentAdmin: string, adminSigner: ethers.Signer) {
    return this.proposeAdminChange(
      AdminChangeKind.REMOVE,
      currentAdmin,
      ethers.ZeroAddress,
      0n,
      adminSigner,
    );
  }

  async proposeReplaceAdmin(currentAdmin: string, newAdmin: string, adminSigner: ethers.Signer) {
    return this.proposeAdminChange(
      AdminChangeKind.REPLACE,
      currentAdmin,
      newAdmin,
      0n,
      adminSigner,
    );
  }

  async proposeApprovalThreshold(newThreshold: bigint, adminSigner: ethers.Signer) {
    return this.proposeAdminChange(
      AdminChangeKind.THRESHOLD,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      newThreshold,
      adminSigner,
    );
  }

  async proposeAddRelayer(relayer: string, adminSigner: ethers.Signer) {
    return this.proposeAdminChange(
      AdminChangeKind.RELAYER_ADD,
      ethers.ZeroAddress,
      relayer,
      0n,
      adminSigner,
    );
  }

  async proposeRemoveRelayer(relayer: string, adminSigner: ethers.Signer) {
    return this.proposeAdminChange(
      AdminChangeKind.RELAYER_REMOVE,
      relayer,
      ethers.ZeroAddress,
      0n,
      adminSigner,
    );
  }

  async approveAdminChange(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.approveAdminChange(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to approve governed role change: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async executeAdminChange(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.executeAdminChange(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to execute governed role change: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async cancelAdminChangeProposal(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.cancelAdminChangeProposal(proposalId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to cancel governed role change: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async approveAddAdmin(proposalId: string | bigint, adminSigner: ethers.Signer) {
    return this.approveAdminChange(proposalId, adminSigner);
  }

  async executeAddAdmin(proposalId: string | bigint, adminSigner: ethers.Signer) {
    return this.executeAdminChange(proposalId, adminSigner);
  }

  async cancelExpiredAddAdminProposal(proposalId: string | bigint, adminSigner: ethers.Signer) {
    return this.cancelAdminChangeProposal(proposalId, adminSigner);
  }
}
