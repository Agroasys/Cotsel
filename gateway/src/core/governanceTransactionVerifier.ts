/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'crypto';
import { AbstractProvider } from 'ethers';
import type { FinalityTagObservation, TransactionFinalityObservation } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { GatewayConfig } from '../config/env';
import type {
  GovernanceObservedTransaction,
  GovernanceObservedTransactionReceipt,
  GovernanceTransactionVerifier,
} from './governanceMutationTypes';
import type {
  GovernancePreparedTransactionRequest,
  GovernanceSimulationEvidence,
} from './governanceStore';

export class RpcGovernanceTransactionVerifier implements GovernanceTransactionVerifier {
  constructor(
    private readonly provider: AbstractProvider,
    private readonly providerIdentity: string,
  ) {}

  async getTransactionCount(walletAddress: string): Promise<number> {
    return this.provider.getTransactionCount(walletAddress, 'pending');
  }

  async simulateTransaction(
    transaction: GovernancePreparedTransactionRequest,
  ): Promise<GovernanceSimulationEvidence> {
    const [network, block] = await Promise.all([
      this.provider.getNetwork(),
      this.provider.getBlock('latest'),
    ]);
    if (!block?.hash || !Number.isSafeInteger(block.number)) {
      throw new Error('RPC did not return an identifiable simulation block');
    }
    const chainId = Number(network.chainId);
    if (!Number.isSafeInteger(chainId) || chainId !== transaction.chainId) {
      throw new Error('RPC simulation chain does not match the prepared transaction');
    }
    const returnData = await this.provider.call({
      chainId: transaction.chainId,
      from: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      nonce: transaction.nonce,
      blockTag: block.number,
      enableCcipRead: false,
    });
    return {
      chainId,
      blockNumber: block.number,
      blockHash: block.hash.toLowerCase(),
      simulatedAt: new Date().toISOString(),
      providerIdentity: this.providerIdentity,
      result: 'success',
      returnDataHash: createHash('sha256').update(returnData).digest('hex'),
      pointInTimeOnly: true,
    };
  }

  async getTransaction(txHash: string): Promise<GovernanceObservedTransaction | null> {
    const tx = await this.provider.getTransaction(txHash);
    if (!tx) {
      return null;
    }

    const chainId = tx.chainId !== undefined && tx.chainId !== null ? Number(tx.chainId) : null;

    return {
      chainId: Number.isFinite(chainId) ? chainId : null,
      to: tx.to ?? null,
      from: tx.from ?? null,
      data: tx.data ?? null,
      value: tx.value?.toString() ?? null,
      nonce: Number.isSafeInteger(tx.nonce) ? tx.nonce : null,
      blockNumber: tx.blockNumber ?? null,
    };
  }

  async getTransactionReceipt(
    txHash: string,
  ): Promise<GovernanceObservedTransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return null;
    }

    const status = receipt.status === 1 ? 'success' : receipt.status === 0 ? 'reverted' : 'unknown';

    return {
      blockNumber: receipt.blockNumber ?? null,
      status,
    };
  }

  async getBlockNumber(): Promise<number | null> {
    return this.provider.getBlockNumber();
  }

  /**
   * Tags are read before the head so a consistent provider can never report a
   * tag ahead of it. Read failures propagate; only an explicit tag rejection
   * is recorded as unsupported, which can only weaken the classification.
   */
  async observeTransactionFinality(txHash: string): Promise<TransactionFinalityObservation> {
    const [network, safeBlockNumber, finalizedBlockNumber] = await Promise.all([
      this.provider.getNetwork(),
      this.readTag('safe'),
      this.readTag('finalized'),
    ]);
    const [latestBlockNumber, receipt] = await Promise.all([
      this.provider.getBlockNumber(),
      this.provider.getTransactionReceipt(txHash),
    ]);
    const canonical = receipt ? await this.provider.getBlock(receipt.blockNumber) : null;
    const status = receipt?.status;
    return {
      providerId: this.providerIdentity,
      chainId: Number(network.chainId),
      latestBlockNumber,
      safeBlockNumber,
      finalizedBlockNumber,
      receipt:
        receipt && (status === 0 || status === 1)
          ? { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status }
          : null,
      canonicalBlockHash: canonical?.hash ?? null,
    };
  }

  private async readTag(tag: 'safe' | 'finalized'): Promise<FinalityTagObservation> {
    try {
      const block = await this.provider.getBlock(tag);
      return block ? block.number : null;
    } catch (error) {
      if (UNSUPPORTED_TAG_ERROR.test(error instanceof Error ? error.message : String(error))) {
        return 'unsupported';
      }
      throw error;
    }
  }
}

const UNSUPPORTED_TAG_ERROR = /block ?tag|unsupported|invalid argument|-32602/i;

export function createDefaultTransactionVerifier(
  config: GatewayConfig,
): GovernanceTransactionVerifier {
  const providerIdentity = `sha256:${createHash('sha256')
    .update(JSON.stringify([config.rpcUrl, ...config.rpcFallbackUrls]))
    .digest('hex')}`;
  return new RpcGovernanceTransactionVerifier(
    createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
      chainId: config.chainId,
      stallTimeoutMs: config.rpcReadTimeoutMs,
    }),
    providerIdentity,
  );
}
