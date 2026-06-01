/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client } from '../client';
import {
  BuyerLockPayload,
  GaslessCreateTradeAuthorization,
  GaslessCreateTradeExecutionRequest,
  GaslessUserActionAuthorization,
  GaslessUserActionExecutionRequest,
  SponsoredAction,
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
import { GaslessSettlementRequestBuilder } from './gaslessExecutionPayload';

export class BuyerSDK extends Client {
  private readonly gaslessSettlementRequestBuilder = new GaslessSettlementRequestBuilder({
    chainId: this.config.chainId,
    escrowAddress: this.config.escrowAddress,
  });

  async getAuthorizationNonce(userAddress: string): Promise<bigint> {
    validateAddress(userAddress, 'user');
    return super.getAuthorizationNonce(userAddress);
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

  async createGaslessTradeExecutionRequest(
    payload: BuyerLockPayload,
    buyerSigner: ethers.Signer,
    input: {
      handoffId: string;
      expiresAt: string | Date;
      usdc?: {
        validAfter?: number;
        validBefore?: number;
        nonce?: string;
        tokenName?: string;
        tokenVersion?: string;
      };
    },
  ): Promise<GaslessCreateTradeExecutionRequest> {
    const authorization = await this.createGaslessTradeAuthorization(payload, buyerSigner);
    const usdcAuthorization = await this.createUsdcReceiveAuthorization(
      payload.totalAmount,
      buyerSigner,
      input.usdc,
    );

    return this.gaslessSettlementRequestBuilder.buildCreateTradeExecutionRequest({
      handoffId: input.handoffId,
      expiresAt: input.expiresAt,
      authorization,
      usdcAuthorization,
    });
  }

  async createGaslessUserActionAuthorization(
    action: Exclude<SponsoredAction, SponsoredAction.CREATE_TRADE>,
    tradeId: string | bigint,
    userSigner: ethers.Signer,
    deadline = Math.floor(Date.now() / 1000) + 3600,
  ): Promise<GaslessUserActionAuthorization> {
    await this.assertSignerCompatibility(userSigner, 'User signer');
    const userAddress = await userSigner.getAddress();
    const nonce = await this.getAuthorizationNonce(userAddress);

    return signGaslessUserActionAuthorization(
      userSigner,
      this.config.chainId,
      this.config.escrowAddress,
      action,
      tradeId,
      nonce,
      deadline,
    );
  }

  async createGaslessUserActionExecutionRequest(
    action: Exclude<SponsoredAction, SponsoredAction.CREATE_TRADE>,
    tradeId: string | bigint,
    userSigner: ethers.Signer,
    input: {
      handoffId: string;
      expiresAt: string | Date;
      deadline?: number;
    },
  ): Promise<GaslessUserActionExecutionRequest> {
    const authorization = await this.createGaslessUserActionAuthorization(
      action,
      tradeId,
      userSigner,
      input.deadline,
    );

    return this.gaslessSettlementRequestBuilder.buildUserActionExecutionRequest({
      action,
      handoffId: input.handoffId,
      expiresAt: input.expiresAt,
      authorization,
    });
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
}
