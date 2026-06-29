/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AbstractProvider, FallbackProvider, JsonRpcProvider } from 'ethers';

export interface ManagedRpcProviderOptions {
  chainId?: number;
  stallTimeoutMs?: number;
  quorum?: number;
}

function normalizeRpcUrls(primaryUrl: string, fallbackUrls: string[] = []): string[] {
  return [primaryUrl, ...fallbackUrls]
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .filter((url, index, entries) => entries.indexOf(url) === index);
}

function toProvider(url: string, chainId?: number): JsonRpcProvider {
  return new JsonRpcProvider(url, chainId);
}

export function createManagedRpcProvider(
  primaryUrl: string,
  fallbackUrls: string[] = [],
  options: ManagedRpcProviderOptions = {},
): AbstractProvider {
  const urls = normalizeRpcUrls(primaryUrl, fallbackUrls);
  const providers = urls.map((url, index) => ({
    provider: toProvider(url, options.chainId),
    priority: index + 1,
    weight: 1,
    stallTimeout: options.stallTimeoutMs ?? 1_500,
  }));

  if (providers.length === 1) {
    return providers[0].provider;
  }

  // Clamp the requested quorum to the number of providers (and at least 1) so
  // an over-specified RPC_QUORUM can never make FallbackProvider throw and take
  // the service down. Quorum is opt-in; the default of 1 keeps liveness first.
  const requestedQuorum = options.quorum ?? 1;
  const quorum = Math.min(Math.max(1, requestedQuorum), providers.length);

  return new FallbackProvider(providers, undefined, {
    quorum,
  });
}
