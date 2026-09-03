import { ethers } from 'ethers';
import { AgroasysEscrow__factory, OracleSDK, Trade } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { SettlementConfirmationHeads } from '@agroasys/sdk';
import { Logger } from '../utils/logger';
import { ManagedSigner, ManagedSignerOptions, SignerCustodyMode } from './managed-signer';
import type { OracleTransactionOutcomeStore } from '../database/transaction-outcome-store';
import { broadcastPersistedOracleTransaction } from './transaction-lifecycle';

export interface BlockchainResult {
  txHash: string;
  blockNumber?: number;
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
    {
      ...signerConfig.managedSigner,
      custodyMode: signerConfig.custodyMode,
      recordValidationEvidence: async (evidence) => {
        await signerConfig.managedSigner?.recordValidationEvidence?.(evidence);
        if (evidence.outcome === 'accepted') {
          Logger.info('Managed signer transaction validated', { ...evidence });
        } else {
          Logger.warn('Managed signer transaction rejected before broadcast', { ...evidence });
        }
      },
    },
    provider,
  );
}

export class SDKClient {
  private sdk: OracleSDK;
  private provider: ethers.AbstractProvider;
  private signer: ethers.Signer;
  private escrow: ReturnType<typeof AgroasysEscrow__factory.connect>;
  private readonly configuredChainId: number;
  private readonly configuredEscrowAddress: string;

  constructor(
    rpcUrl: string,
    rpcFallbackUrls: string[],
    signerConfig: OracleSignerConfig,
    escrowAddress: string,
    usdcAddress: string,
    chainId: number,
    private readonly transactionOutcomeStore: OracleTransactionOutcomeStore,
    rpcOptions: { quorum?: number; stallTimeoutMs?: number } = {},
  ) {
    const provider = createManagedRpcProvider(rpcUrl, rpcFallbackUrls, {
      chainId,
      quorum: rpcOptions.quorum,
      stallTimeoutMs: rpcOptions.stallTimeoutMs,
    });
    this.provider = provider;
    this.signer = createOracleSigner(signerConfig, provider);
    this.escrow = AgroasysEscrow__factory.connect(escrowAddress, this.signer);
    this.configuredChainId = chainId;
    this.configuredEscrowAddress = ethers.getAddress(escrowAddress);

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

  async getTransactionRecoveryState(txHash: string): Promise<{
    receipt: ethers.TransactionReceipt | null;
    transaction: ethers.TransactionResponse | null;
  }> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (receipt) {
      return { receipt, transaction: null };
    }
    return { receipt: null, transaction: await this.provider.getTransaction(txHash) };
  }

  async getSignerTransactionCount(
    signerAddress: string,
    blockTag: 'latest' | 'pending',
  ): Promise<number> {
    return this.provider.getTransactionCount(signerAddress, blockTag);
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

  async isTradePaused(tradeId: string): Promise<boolean> {
    return this.sdk.isTradePaused(BigInt(tradeId));
  }

  private async assertAuthorizedOracleSigner(): Promise<void> {
    const [signerAddress, oracleAddress] = await Promise.all([
      this.signer.getAddress(),
      this.sdk.getOracleAddress(),
    ]);
    if (ethers.getAddress(signerAddress) !== ethers.getAddress(oracleAddress)) {
      throw new Error('Configured Oracle signer is not authorized by the escrow contract');
    }
  }

  private async submitOracleTransaction(
    triggerIdempotencyKey: string,
    operation: 'releaseFundsStage1' | 'confirmInspectionAvailable' | 'finalizeAfterDisputeWindow',
    args: readonly unknown[],
  ): Promise<BlockchainResult> {
    await this.assertAuthorizedOracleSigner();
    const request = await this.escrow.getFunction(operation).populateTransaction(...args);
    const populated = await this.signer.populateTransaction(request);
    const signedTransaction = await this.signer.signTransaction(populated);
    const response = await broadcastPersistedOracleTransaction(
      signedTransaction,
      {
        triggerIdempotencyKey,
        expectedChainId: this.configuredChainId,
        expectedDestination: this.configuredEscrowAddress,
      },
      this.transactionOutcomeStore,
      (signed) => this.provider.broadcastTransaction(signed),
    );
    return { txHash: response.hash };
  }

  async releaseFundsStage1(
    tradeId: string,
    triggerIdempotencyKey: string,
  ): Promise<BlockchainResult> {
    Logger.info('Preparing releaseFundsStage1', { tradeId });
    return this.submitOracleTransaction(triggerIdempotencyKey, 'releaseFundsStage1', [tradeId]);
  }

  async confirmInspectionAvailable(
    tradeId: string,
    windowSeconds: number,
    triggerIdempotencyKey: string,
  ): Promise<BlockchainResult> {
    Logger.info('Preparing confirmInspectionAvailable', { tradeId, windowSeconds });
    return this.submitOracleTransaction(triggerIdempotencyKey, 'confirmInspectionAvailable', [
      tradeId,
      windowSeconds,
    ]);
  }

  async finalizeTrade(tradeId: string, triggerIdempotencyKey: string): Promise<BlockchainResult> {
    Logger.info('Preparing finalizeAfterDisputeWindow', { tradeId });
    return this.submitOracleTransaction(triggerIdempotencyKey, 'finalizeAfterDisputeWindow', [
      tradeId,
    ]);
  }
}
