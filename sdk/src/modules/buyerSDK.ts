/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client } from '../client';
import {
  BuyerLockPayload,
  GaslessCreateTradeAuthorization,
  GaslessUserActionAuthorization,
  SponsoredAction,
  TradeResult,
  UsdcReceiveAuthorization,
} from '../types/trade';
import { ethers } from 'ethers';
import { validateTradeParameters, validateAddress } from '../utils/validation';
import {
  signGaslessCreateTradeAuthorization,
  signGaslessUserActionAuthorization,
  signUsdcReceiveAuthorization,
} from '../utils/signature';
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

  async getAuthorizationNonce(userAddress: string): Promise<bigint> {
    validateAddress(userAddress, 'user');
    const contract = this.contract as unknown as {
      getAuthorizationNonce(userAddress: string): Promise<bigint>;
    };
    return contract.getAuthorizationNonce(userAddress);
  }

  async createGaslessTradeAuthorization(
    payload: BuyerLockPayload,
    buyerSigner: ethers.Signer,
  ): Promise<GaslessCreateTradeAuthorization> {
    validateTradeParameters(payload);
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');
    const buyerAddress = await buyerSigner.getAddress();
    const nonce = await this.getAuthorizationNonce(buyerAddress);
    const deadline = payload.deadline || Math.floor(Date.now() / 1000) + 3600;

    return signGaslessCreateTradeAuthorization(
      buyerSigner,
      this.config.chainId,
      this.config.escrowAddress,
      payload,
      nonce,
      deadline,
    );
  }

  async createUsdcReceiveAuthorization(
    amount: bigint,
    buyerSigner: ethers.Signer,
    input?: {
      validAfter?: number;
      validBefore?: number;
      nonce?: string;
      tokenName?: string;
      tokenVersion?: string;
    },
  ): Promise<UsdcReceiveAuthorization> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');
    const now = Math.floor(Date.now() / 1000);

    return signUsdcReceiveAuthorization(buyerSigner, this.config.chainId, this.config.usdcAddress, {
      to: this.config.escrowAddress,
      value: amount,
      validAfter: input?.validAfter ?? 0,
      validBefore: input?.validBefore ?? now + 3600,
      nonce: input?.nonce,
      tokenName: input?.tokenName,
      tokenVersion: input?.tokenVersion,
    });
  }

  async createGaslessUserActionAuthorization(
    action: Exclude<SponsoredAction, SponsoredAction.CREATE_TRADE>,
    tradeId: string | bigint,
    buyerSigner: ethers.Signer,
    deadline = Math.floor(Date.now() / 1000) + 3600,
  ): Promise<GaslessUserActionAuthorization> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');
    const buyerAddress = await buyerSigner.getAddress();
    const nonce = await this.getAuthorizationNonce(buyerAddress);

    return signGaslessUserActionAuthorization(
      buyerSigner,
      this.config.chainId,
      this.config.escrowAddress,
      action,
      tradeId,
      nonce,
      deadline,
    );
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
   * Deprecated direct buyer-paid lock flow.
   *
   * User-paid settlement writes were removed from the contract. Keep this
   * method as an explicit migration guard so older integrations fail with an
   * actionable error instead of trying to call a removed ABI method.
   *
   * New checkout integrations should use `createGaslessTradeExecutionRequest`
   * plus `GaslessSettlementClient.submitCreateTradeExecution`.
   */
  async createTrade(payload: BuyerLockPayload, buyerSigner: ethers.Signer): Promise<TradeResult> {
    validateTradeParameters(payload);
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    throw new ContractError(
      'Direct buyer-paid createTrade was removed. Use createGaslessTradeExecutionRequest and GaslessSettlementClient.submitCreateTradeExecution instead.',
      {
        supplier: payload.supplier,
        totalAmount: payload.totalAmount.toString(),
        ricardianHash: payload.ricardianHash,
      },
    );
  }

  async openDispute(tradeId: string | bigint, buyerSigner: ethers.Signer): Promise<TradeResult> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    throw new ContractError(
      'Direct buyer-paid openDispute was removed. Use createGaslessUserActionRequest with SponsoredAction.OPEN_DISPUTE instead.',
      { tradeId: tradeId.toString() },
    );
  }

  async cancelLockedTradeAfterTimeout(
    tradeId: string | bigint,
    buyerSigner: ethers.Signer,
  ): Promise<TradeResult> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    throw new ContractError(
      'Direct buyer-paid cancelLockedTradeAfterTimeout was removed. Use createGaslessUserActionRequest with SponsoredAction.CANCEL_LOCKED_TIMEOUT instead.',
      { tradeId: tradeId.toString() },
    );
  }

  async refundInTransitAfterTimeout(
    tradeId: string | bigint,
    buyerSigner: ethers.Signer,
  ): Promise<TradeResult> {
    await this.assertSignerCompatibility(buyerSigner, 'Buyer signer');

    throw new ContractError(
      'Direct buyer-paid refundInTransitAfterTimeout was removed. Use createGaslessUserActionRequest with SponsoredAction.REFUND_IN_TRANSIT_TIMEOUT instead.',
      { tradeId: tradeId.toString() },
    );
  }
}
