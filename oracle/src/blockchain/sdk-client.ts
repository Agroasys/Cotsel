import { ethers } from 'ethers';
import { OracleSDK, Trade } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { SettlementConfirmationHeads } from '@agroasys/sdk';
import { Logger } from '../utils/logger';

export interface BlockchainResult {
  txHash: string;
  blockNumber: number;
}

export class SDKClient {
  private sdk: OracleSDK;
  private provider: ethers.AbstractProvider;
  private signer: ethers.Wallet;

  constructor(
    rpcUrl: string,
    rpcFallbackUrls: string[],
    privateKey: string,
    escrowAddress: string,
    usdcAddress: string,
    chainId: number,
    rpcOptions: { quorum?: number; stallTimeoutMs?: number } = {},
  ) {
    const provider = createManagedRpcProvider(rpcUrl, rpcFallbackUrls, {
      chainId,
      quorum: rpcOptions.quorum,
      stallTimeoutMs: rpcOptions.stallTimeoutMs,
    });
    this.provider = provider;
    this.signer = new ethers.Wallet(privateKey, provider);

    this.sdk = new OracleSDK({
      rpc: rpcUrl,
      rpcFallbackUrls,
      rpcQuorum: rpcOptions.quorum,
      rpcStallTimeoutMs: rpcOptions.stallTimeoutMs,
      chainId,
      escrowAddress,
      usdcAddress,
    });

    Logger.info('SDKClient initialized', {
      oracleAddress: this.signer.address,
      escrowAddress,
      chainId,
    });
  }

  private async getBlockNumberForTag(tag: 'latest' | 'safe' | 'finalized'): Promise<number | null> {
    const block = await this.provider.getBlock(tag);
    return block ? Number(block.number) : null;
  }

  async getSettlementConfirmationHeads(): Promise<SettlementConfirmationHeads> {
    const [latestBlockNumber, safeBlockNumber, finalizedBlockNumber] = await Promise.all([
      this.getBlockNumberForTag('latest'),
      this.getBlockNumberForTag('safe'),
      this.getBlockNumberForTag('finalized'),
    ]);

    if (latestBlockNumber === null) {
      throw new Error('Managed RPC provider returned no latest block for settlement confirmation');
    }

    return {
      latestBlockNumber,
      safeBlockNumber,
      finalizedBlockNumber,
    };
  }

  async getTransactionReceiptBlockNumber(txHash: string): Promise<number | null> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    return receipt ? Number(receipt.blockNumber) : null;
  }

  async getTrade(tradeId: string): Promise<Trade> {
    Logger.info('Querying on-chain trade state', { tradeId });
    const trade = await this.sdk.getTrade(tradeId);

    if (
      !trade ||
      trade.tradeId === '0' ||
      trade.buyer === '0x0000000000000000000000000000000000000000'
    ) {
      const { ValidationError } = await import('../utils/errors');
      throw new ValidationError(`Trade ${tradeId} does not exist on-chain`);
    }

    return trade;
  }

  async releaseFundsStage1(tradeId: string): Promise<BlockchainResult> {
    Logger.info('Executing releaseFundsStage1', { tradeId });

    const result = await this.sdk.releaseFundsStage1(tradeId, this.signer);

    Logger.info('Stage 1 release successful', {
      tradeId,
      txHash: result.txHash,
    });

    return {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
    };
  }

  async confirmArrival(tradeId: string): Promise<BlockchainResult> {
    Logger.info('Executing confirmArrival', { tradeId });

    const result = await this.sdk.confirmArrival(tradeId, this.signer);

    Logger.info('Arrival confirmation successful', {
      tradeId,
      txHash: result.txHash,
    });

    return {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
    };
  }

  async finalizeTrade(tradeId: string): Promise<BlockchainResult> {
    Logger.info('Executing finalizeTrade', { tradeId });

    const result = await this.sdk.finalizeAfterDisputeWindow(tradeId, this.signer);

    Logger.info('Trade finalization successful', {
      tradeId,
      txHash: result.txHash,
    });

    return {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
    };
  }
}
