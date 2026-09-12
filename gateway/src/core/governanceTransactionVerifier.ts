/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AbstractProvider } from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import type { GatewayConfig } from '../config/env';
import type {
  GovernanceObservedTransaction,
  GovernanceObservedTransactionReceipt,
  GovernanceTransactionVerifier,
} from './governanceMutationTypes';

class RpcGovernanceTransactionVerifier implements GovernanceTransactionVerifier {
  constructor(private readonly provider: AbstractProvider) {}

  async getTransactionCount(walletAddress: string): Promise<number> {
    return this.provider.getTransactionCount(walletAddress, 'pending');
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
}

export function createDefaultTransactionVerifier(
  config: GatewayConfig,
): GovernanceTransactionVerifier {
  return new RpcGovernanceTransactionVerifier(
    createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
      chainId: config.chainId,
      stallTimeoutMs: config.rpcReadTimeoutMs,
    }),
  );
}
