import { ethers } from 'ethers';
import { OracleSDK, Trade } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { SettlementConfirmationHeads } from '@agroasys/sdk';
import { Logger } from '../utils/logger';
import { ManagedSigner, ManagedSignerOptions, SignerCustodyMode } from './managed-signer';

export interface BlockchainResult {
  txHash: string;
  blockNumber: number;
}

export interface OracleSignerConfig {
  custodyMode: SignerCustodyMode;
  privateKey?: string;
  managedSigner?: Omit<ManagedSignerOptions, 'custodyMode'>;
}

function createOracleSigner(
  signerConfig: OracleSignerConfig,
  provider: ethers.Provider,
): ethers.Signer {
  if (signerConfig.custodyMode === 'raw_private_key') {
    if (!signerConfig.privateKey) {
      throw new Error('ORACLE_PRIVATE_KEY is required for raw_private_key signer custody');
    }
    return new ethers.Wallet(signerConfig.privateKey, provider);
  }

  if (!signerConfig.managedSigner) {
    throw new Error(
      `Managed signer configuration is required for ${signerConfig.custodyMode} custody`,
    );
  }

  return new ManagedSigner(
    { ...signerConfig.managedSigner, custodyMode: signerConfig.custodyMode },
    provider,
  );
}

export class SDKClient {
  private sdk: OracleSDK;
  private provider: ethers.AbstractProvider;
  private signer: ethers.Signer;

  constructor(
    rpcUrl: string,
    rpcFallbackUrls: string[],
    signerConfig: OracleSignerConfig,
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
    this.signer = createOracleSigner(signerConfig, provider);

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
      custodyMode: signerConfig.custodyMode,
      escrowAddress,
      chainId,
    });

    // Signer address may require a network call for managed custody, so resolve it
    // out of band for observability without blocking construction.
    void this.signer
      .getAddress()
      .then((oracleAddress) => Logger.info('Oracle signer resolved', { oracleAddress }))
      .catch((error) => Logger.warn('Failed to resolve oracle signer address', { error }));
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

  async confirmInspectionAvailable(
    tradeId: string,
    windowSeconds: number,
  ): Promise<BlockchainResult> {
    Logger.info('Executing confirmInspectionAvailable', { tradeId, windowSeconds });

    const result = await this.sdk.confirmInspectionAvailable(tradeId, windowSeconds, this.signer);

    Logger.info('Inspection availability confirmation successful', {
      tradeId,
      windowSeconds,
      txHash: result.txHash,
    });

    return {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
    };
  }

  async finalizeAfterInspectionAcceptance(tradeId: string): Promise<BlockchainResult> {
    Logger.info('Executing finalizeAfterInspectionAcceptance', { tradeId });

    const result = await this.sdk.finalizeAfterInspectionAcceptance(tradeId, this.signer);

    Logger.info('Inspection acceptance finalization successful', {
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
