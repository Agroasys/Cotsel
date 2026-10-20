import { verifyOracleProgressionReceipt } from './progression-receipt';
import { createOracleDispatchWitnesses, verifyOracleDispatchFinality } from './dispatch-finality';
import { createFundedSettlementVerifier } from './funded-settlement-verifier';
import {
  parseSettlementFundedBinding,
  assertFundedTradeMatchesBinding,
  type SettlementFundedBinding,
} from '@agroasys/sdk';
import { ethers } from 'ethers';
import { OracleSDK, Trade } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { SettlementConfirmationHeads } from '@agroasys/sdk';
import { Logger } from '../utils/logger';
import { ManagedSigner, ManagedSignerOptions, SignerCustodyMode } from './managed-signer';
import {
  createAwsKmsOracleKeyProbe,
  createAwsKmsOracleSigner,
  createAwsKmsSigningClient,
} from './aws-kms-signer';

export interface BlockchainResult {
  txHash: string;
  blockNumber: number;
}

export interface OracleSignerConfig {
  custodyMode: SignerCustodyMode;
  privateKey?: string;
  kmsSigner?: { keyId: string; expectedAddress: string };
  managedSigner?: Omit<ManagedSignerOptions, 'custodyMode'>;
}

interface OracleSignerBinding {
  signer: ethers.Signer;
  /** Proves the signer can be reached now, independent of any cached startup state. */
  probe: () => Promise<void>;
}

function createOracleSigner(
  signerConfig: OracleSignerConfig,
  provider: ethers.Provider,
): OracleSignerBinding {
  if (signerConfig.custodyMode === 'raw_private_key') {
    if (!signerConfig.privateKey) {
      throw new Error('ORACLE_PRIVATE_KEY is required for raw_private_key signer custody');
    }
    return { signer: new ethers.Wallet(signerConfig.privateKey, provider), probe: async () => {} };
  }

  if (signerConfig.custodyMode === 'kms') {
    if (!signerConfig.kmsSigner) {
      throw new Error('AWS KMS signer configuration is required for kms custody');
    }
    const client = createAwsKmsSigningClient();
    return {
      signer: createAwsKmsOracleSigner(signerConfig.kmsSigner, provider, client),
      probe: createAwsKmsOracleKeyProbe(signerConfig.kmsSigner, client),
    };
  }

  if (!signerConfig.managedSigner) {
    throw new Error(
      `Managed signer configuration is required for ${signerConfig.custodyMode} custody`,
    );
  }

  const managedSigner = new ManagedSigner(
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
  return { signer: managedSigner, probe: () => managedSigner.checkReadiness() };
}

export class SDKClient {
  private dispatchWitnesses: ReturnType<typeof createOracleDispatchWitnesses>;
  private dispatchChainId: number;
  private sdk: OracleSDK;
  private provider: ethers.AbstractProvider;
  private signer: ethers.Signer;
  private signerProbe: () => Promise<void>;
  private verifyFunding: (binding: SettlementFundedBinding) => Promise<void>;

  constructor(
    rpcUrl: string,
    rpcFallbackUrls: string[],
    signerConfig: OracleSignerConfig,
    escrowAddress: string,
    usdcAddress: string,
    chainId: number,
    rpcOptions: { quorum?: number; stallTimeoutMs?: number } = {},
  ) {
    this.dispatchChainId = chainId;
    this.dispatchWitnesses = createOracleDispatchWitnesses([rpcUrl, ...rpcFallbackUrls]);
    this.verifyFunding = createFundedSettlementVerifier(
      { chainId, escrowAddress, tokenAddress: usdcAddress },
      [rpcUrl, ...rpcFallbackUrls],
    );
    const provider = createManagedRpcProvider(rpcUrl, rpcFallbackUrls, {
      chainId,
      quorum: rpcOptions.quorum,
      stallTimeoutMs: rpcOptions.stallTimeoutMs,
    });
    this.provider = provider;
    const signerBinding = createOracleSigner(signerConfig, provider);
    this.signer = signerBinding.signer;
    this.signerProbe = signerBinding.probe;

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
  }

  /** Readiness: the managed RPC answers with a current block. */
  async checkRpcReadiness(): Promise<void> {
    await this.provider.getBlockNumber();
  }

  /** Readiness: the configured signer custody answers now, not just at startup. */
  async checkSignerReadiness(): Promise<void> {
    await this.signerProbe();
  }

  async assertSignerReady(): Promise<string> {
    const oracleAddress = await this.signer.getAddress();
    Logger.info('Oracle signer resolved', { oracleAddress });
    return oracleAddress;
  }

  async getDispatchSignerScope(): Promise<string> {
    return `${this.dispatchChainId}:${(await this.signer.getAddress()).toLowerCase()}`;
  }

  async verifyDispatchFinality(signerScope: string, transactionHash: string) {
    return verifyOracleDispatchFinality(this.dispatchWitnesses, signerScope, transactionHash);
  }

  async verifyProgressionReceipt(
    signerScope: string,
    transactionHash: string,
    binding: SettlementFundedBinding,
  ) {
    await this.assertFundedBinding(binding);
    return verifyOracleProgressionReceipt(
      this.dispatchWitnesses,
      signerScope,
      transactionHash,
      binding,
    );
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
    return receipt?.status === 1 ? Number(receipt.blockNumber) : null;
  }

  async assertFundedBinding(value: SettlementFundedBinding): Promise<void> {
    const binding = parseSettlementFundedBinding(value);
    await this.verifyFunding(binding);
    assertFundedTradeMatchesBinding(await this.getTrade(binding.tradeId), binding);
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

  async releaseFundsStage1(
    tradeId: string,
    onSubmitted?: (hash: string) => Promise<void>,
  ): Promise<BlockchainResult> {
    Logger.info('Executing releaseFundsStage1', { tradeId });

    const result = await this.sdk.releaseFundsStage1(tradeId, this.signer, onSubmitted);

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
    onSubmitted?: (hash: string) => Promise<void>,
  ): Promise<BlockchainResult> {
    Logger.info('Executing confirmInspectionAvailable', { tradeId, windowSeconds });

    const result = await this.sdk.confirmInspectionAvailable(
      tradeId,
      windowSeconds,
      this.signer,
      onSubmitted,
    );

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

  async finalizeTrade(
    tradeId: string,
    onSubmitted?: (hash: string) => Promise<void>,
  ): Promise<BlockchainResult> {
    Logger.info('Executing finalizeTrade', { tradeId });

    const result = await this.sdk.finalizeAfterDisputeWindow(tradeId, this.signer, onSubmitted);

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
