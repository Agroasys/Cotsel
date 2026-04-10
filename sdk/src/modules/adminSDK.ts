/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client } from '../client';
import { ethers } from 'ethers';
import { DisputeStatus, DisputeResult } from '../types/dispute';
import { GovernanceProposalResult, GovernanceResult } from '../types/governance';
import {
  AuthorizationError,
  ContractError,
  getErrorMessage,
  ValidationError,
} from '../types/errors';
import { validateAddress } from '../utils/validation';

export class AdminSDK extends Client {
  private async verifyAdmin(adminSigner: ethers.Signer): Promise<void> {
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

  async proposeUnpause(adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.proposeUnpause();
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

  async unpauseClaims(adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.unpauseClaims();
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
      throw new ContractError(`Failed to unpause claims: ${message}`, {
        error: message,
      });
    }
  }

  async claimTreasury(triggerSigner: ethers.Signer): Promise<GovernanceResult> {
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
  ): Promise<DisputeResult> {
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

  async proposeAddAdmin(newAdmin: string, adminSigner: ethers.Signer): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);
    validateAddress(newAdmin, 'newAdmin');

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.proposeAddAdmin(newAdmin);
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
      throw new ContractError(`Failed to propose admin addition: ${message}`, {
        newAdmin,
        error: message,
      });
    }
  }

  async approveAddAdmin(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.approveAddAdmin(proposalId);
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
      throw new ContractError(`Failed to approve admin addition: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async executeAddAdmin(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.executeAddAdmin(proposalId);
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
      throw new ContractError(`Failed to execute admin addition: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }

  async cancelExpiredAddAdminProposal(
    proposalId: string | bigint,
    adminSigner: ethers.Signer,
  ): Promise<GovernanceResult> {
    await this.verifyAdmin(adminSigner);

    try {
      const contractWithSigner = this.contract.connect(adminSigner);
      const tx = await contractWithSigner.cancelExpiredAddAdminProposal(proposalId);
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
      throw new ContractError(`Failed to cancel expired admin addition proposal: ${message}`, {
        proposalId: proposalId.toString(),
        error: message,
      });
    }
  }
}
