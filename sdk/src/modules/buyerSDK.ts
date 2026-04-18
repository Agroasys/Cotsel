/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client } from '../client';
import { BuyerLockPayload, TradeResult } from '../types/trade';
import { ethers } from 'ethers';
import { validateTradeParameters, validateAddress } from '../utils/validation';
import { signTradeMessage } from '../utils/signature';
import { ContractError, getErrorMessage } from '../types/errors';
import { IERC20__factory } from '../types/typechain-types/factories/@openzeppelin/contracts/token/ERC20/IERC20__factory';

export class BuyerSDK extends Client {
  private extractTradeIdFromReceipt(receipt: ethers.TransactionReceipt): string | undefined {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.config.escrowAddress.toLowerCase()) {
        continue;
      }

      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === 'TradeLocked') {
          return BigInt(parsed.args.tradeId).toString();
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  async getBuyerNonce(buyerAddress: string): Promise<bigint> {
    validateAddress(buyerAddress, 'buyer');
    return super.getBuyerNonce(buyerAddress);
  }

  async approveUSDC(amount: bigint, buyerSigner: ethers.Signer): Promise<TradeResult> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    try {
      const usdcContract = IERC20__factory.connect(this.config.usdcAddress, buyerSigner);

      const tx = await usdcContract.approve(this.config.escrowAddress, amount);

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
      throw new ContractError(`Failed to approve USDC: ${message}`, {
        amount: amount.toString(),
        error: message,
      });
    }
  }

  async getUSDCAllowance(buyerAddress: string): Promise<bigint> {
    validateAddress(buyerAddress, 'buyer');
    try {
      const usdcContract = IERC20__factory.connect(this.config.usdcAddress, this.provider);

      return await usdcContract.allowance(buyerAddress, this.config.escrowAddress);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get USDC allowance: ${message}`, {
        buyerAddress,
        error: message,
      });
    }
  }

  async getUSDCBalance(buyerAddress: string): Promise<bigint> {
    validateAddress(buyerAddress, 'buyer');
    try {
      const usdcContract = IERC20__factory.connect(this.config.usdcAddress, this.provider);

      return await usdcContract.balanceOf(buyerAddress);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get USDC balance: ${message}`, {
        buyerAddress,
        error: message,
      });
    }
  }

  /**
   * Lock funds and create a new trade in the escrow contract.
   *
   * This is the primary entry point for external checkout UIs. The `payload`
   * parameter MUST conform to the {@link BuyerLockPayload} canonical contract.
   *
   * **Flow executed by this method:**
   * 1. Validates every field in `payload` (amount invariant, address, hash format).
   * 2. Checks current USDC allowance; issues an `approve` tx if insufficient.
   * 3. Derives the on-chain nonce via `getBuyerNonce` — callers MUST NOT supply a nonce.
   * 4. Applies `payload.deadline` or defaults to `now + 3600`.
   * 5. Signs the canonical EIP-191 trade message.
   * 6. Submits `createTrade` to the escrow contract and returns the receipt.
   *
   * @param payload  Canonical buyer lock payload — see {@link BuyerLockPayload}.
   * @param buyerSigner  Ethers signer for the buyer wallet (signs and pays gas).
   * @returns Transaction hash and block number of the confirmed lock transaction.
   *
   * @see {@link BuyerLockPayload} for full field semantics and the amount invariant.
   */
  async createTrade(payload: BuyerLockPayload, buyerSigner: ethers.Signer): Promise<TradeResult> {
    validateTradeParameters(payload);
    const params = payload;
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    const buyerAddress = await buyerSigner.getAddress();

    const currentAllowance = await this.getUSDCAllowance(buyerAddress);

    if (currentAllowance < params.totalAmount) {
      await this.approveUSDC(params.totalAmount, buyerSigner);
    }

    const nonce = await this.getBuyerNonce(buyerAddress);

    const deadline = params.deadline || Math.floor(Date.now() / 1000) + 3600;

    const treasuryAddress = await this.getTreasuryAddress();

    const signature = await signTradeMessage(
      buyerSigner,
      this.config.chainId,
      this.config.escrowAddress,
      treasuryAddress,
      params,
      nonce,
      deadline,
    );

    try {
      const contractWithSigner = this.contract.connect(buyerSigner);

      const tx = await contractWithSigner.createTrade(
        params.supplier,
        params.totalAmount,
        params.logisticsAmount,
        params.platformFeesAmount,
        params.supplierFirstTranche,
        params.supplierSecondTranche,
        params.ricardianHash,
        nonce,
        deadline,
        signature,
      );

      const receipt = await tx.wait();

      if (!receipt) {
        throw new ContractError('Transaction receipt not available');
      }

      const tradeId = this.extractTradeIdFromReceipt(receipt);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        ...(tradeId ? { tradeId } : {}),
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to create trade: ${message}`, {
        error: message,
        params: {
          supplier: params.supplier,
          totalAmount: params.totalAmount.toString(),
          ricardianHash: params.ricardianHash,
        },
      });
    }
  }

  async openDispute(tradeId: string | bigint, buyerSigner: ethers.Signer): Promise<TradeResult> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    try {
      const contractWithSigner = this.contract.connect(buyerSigner);
      const tx = await contractWithSigner.openDispute(tradeId);
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
      throw new ContractError(`Failed to open dispute: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }

  async cancelLockedTradeAfterTimeout(
    tradeId: string | bigint,
    buyerSigner: ethers.Signer,
  ): Promise<TradeResult> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    try {
      const contractWithSigner = this.contract.connect(buyerSigner);
      const tx = await contractWithSigner.cancelLockedTradeAfterTimeout(tradeId);
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
      throw new ContractError(`Failed to cancel locked trade: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }

  async refundInTransitAfterTimeout(
    tradeId: string | bigint,
    buyerSigner: ethers.Signer,
  ): Promise<TradeResult> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    try {
      const contractWithSigner = this.contract.connect(buyerSigner);
      const tx = await contractWithSigner.refundInTransitAfterTimeout(tradeId);
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
      throw new ContractError(`Failed to refund in-transit trade: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }
}
