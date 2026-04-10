/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client } from '../client';
import { ethers } from 'ethers';
import { ContractError, AuthorizationError, getErrorMessage } from '../types/errors';
import { OracleResult } from '../types/oracle';
import { Trade, TradeStatus } from '../types/trade';

export class OracleSDK extends Client {
  private async verifyOracle(oracleSigner: ethers.Signer): Promise<void> {
    const oracleAddress = await oracleSigner.getAddress();
    const authorizedOracle = await this.getOracleAddress();

    if (oracleAddress.toLowerCase() !== authorizedOracle.toLowerCase()) {
      throw new AuthorizationError('Caller is not the authorized oracle', {
        caller: oracleAddress,
        authorizedOracle,
      });
    }
  }

  async releaseFundsStage1(
    tradeId: string | bigint,
    oracleSigner: ethers.Signer,
  ): Promise<OracleResult> {
    await this.verifyOracle(oracleSigner);

    try {
      const contractWithSigner = this.contract.connect(oracleSigner);
      const tx = await contractWithSigner.releaseFundsStage1(tradeId);
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
      throw new ContractError(`Failed to release stage 1 funds: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }

  async confirmArrival(
    tradeId: string | bigint,
    oracleSigner: ethers.Signer,
  ): Promise<OracleResult> {
    await this.verifyOracle(oracleSigner);

    try {
      const contractWithSigner = this.contract.connect(oracleSigner);
      const tx = await contractWithSigner.confirmArrival(tradeId);
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
      throw new ContractError(`Failed to confirm arrival: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }

  async finalizeAfterDisputeWindow(
    tradeId: string | bigint,
    signer: ethers.Signer,
  ): Promise<OracleResult> {
    try {
      const contractWithSigner = this.contract.connect(signer);
      const tx = await contractWithSigner.finalizeAfterDisputeWindow(tradeId);
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
      throw new ContractError(`Failed to finalize trade: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }

  async getTrade(tradeId: string | bigint): Promise<Trade> {
    try {
      const trade = await this.contract.trades(tradeId);

      return {
        tradeId: trade.tradeId.toString(),
        buyer: trade.buyerAddress,
        supplier: trade.supplierAddress,
        status: Number(trade.status) as TradeStatus,
        totalAmountLocked: trade.totalAmountLocked,
        logisticsAmount: trade.logisticsAmount,
        platformFeesAmount: trade.platformFeesAmount,
        supplierFirstTranche: trade.supplierFirstTranche,
        supplierSecondTranche: trade.supplierSecondTranche,
        ricardianHash: trade.ricardianHash,
        createdAt: new Date(Number(trade.createdAt) * 1000),
        arrivalTimestamp:
          trade.arrivalTimestamp && Number(trade.arrivalTimestamp) > 0
            ? new Date(Number(trade.arrivalTimestamp) * 1000)
            : undefined,
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get trade: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }
}
