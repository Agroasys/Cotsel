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

  return new FallbackProvider(providers, undefined, {
    quorum: options.quorum ?? 1,
  });
}
