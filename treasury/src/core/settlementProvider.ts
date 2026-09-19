/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one place treasury builds a settlement RPC provider from configuration.
 *
 * Eligibility and canonicality both read the chain, and both were about to
 * carry their own copy of this construction. A second copy is a second place
 * for the quorum and fallback settings to drift, and those settings are what
 * make a single lying provider unable to decide a payout on its own.
 */
import { createManagedRpcProvider } from '@agroasys/sdk';
import { config } from '../config';

export function createSettlementProvider(): ReturnType<typeof createManagedRpcProvider> | null {
  if (!config.rpcUrl || !config.chainId) {
    return null;
  }

  return createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
    chainId: config.chainId,
    quorum: config.rpcQuorum,
    stallTimeoutMs: config.rpcStallTimeoutMs,
  });
}
