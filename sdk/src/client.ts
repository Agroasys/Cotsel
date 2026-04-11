/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AbstractProvider, ethers } from 'ethers';
import { Config } from './config';
import { ContractError, getErrorMessage } from './types/errors';
import { AgroasysEscrow__factory } from './types/typechain-types/factories/src/AgroasysEscrow__factory';
import type { AgroasysEscrow } from './types/typechain-types/src/AgroasysEscrow';
import { createManagedRpcProvider } from './rpc/failoverProvider';

export class Client {
  protected provider: AbstractProvider;
  protected contract: AgroasysEscrow;

  constructor(protected config: Config) {
    this.provider = createManagedRpcProvider(config.rpc, config.rpcFallbackUrls, {
      chainId: config.chainId,
    });
    this.contract = AgroasysEscrow__factory.connect(config.escrowAddress, this.provider);
  }

  async getBuyerNonce(buyerAddress: string): Promise<bigint> {
    try {
      return await this.contract.getBuyerNonce(buyerAddress);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get buyer nonce: ${message}`, {
        buyerAddress,
        error: message,
      });
    }
  }

  async getTreasuryAddress(): Promise<string> {
    try {
      return await this.contract.treasuryAddress();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get treasury address: ${message}`, {
        error: message,
      });
    }
  }

  async getTreasuryPayoutAddress(): Promise<string> {
    try {
      return await this.contract.treasuryPayoutAddress();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get treasury payout address: ${message}`, {
        error: message,
      });
    }
  }

  async getOracleAddress(): Promise<string> {
    try {
      return await this.contract.oracleAddress();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get oracle address: ${message}`, {
        error: message,
      });
    }
  }

  async isAdmin(address: string): Promise<boolean> {
    try {
      return await this.contract.isAdmin(address);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to check admin status: ${message}`, {
        address,
        error: message,
      });
    }
  }

  async isPaused(): Promise<boolean> {
    try {
      return await this.contract.paused();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to check paused state: ${message}`, {
        error: message,
      });
    }
  }

  async isClaimsPaused(): Promise<boolean> {
    try {
      return await this.contract.claimsPaused();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to check claimsPaused state: ${message}`, {
        error: message,
      });
    }
  }

  async getClaimableUsdc(address: string): Promise<bigint> {
    try {
      return await this.contract.claimableUsdc(address);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get claimable USDC: ${message}`, {
        address,
        error: message,
      });
    }
  }

  async getTotalClaimableUsdc(): Promise<bigint> {
    try {
      return await this.contract.totalClaimableUsdc();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get total claimable USDC: ${message}`, {
        error: message,
      });
    }
  }

  async claim(signer: ethers.Signer): Promise<{ txHash: string; blockNumber: number }> {
    try {
      const contractWithSigner = this.contract.connect(signer);
      const tx = await contractWithSigner.claim();
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
      throw new ContractError(`Failed to claim USDC: ${message}`, { error: message });
    }
  }
}
