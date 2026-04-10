/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'ethers';

export type Eip1193RequestArguments = {
  method: string;
  params?: readonly unknown[] | Record<string, unknown>;
};

export type Eip1193ProviderLike = {
  request(args: Eip1193RequestArguments): Promise<unknown>;
};

/**
 * Build an ethers signer from an injected EIP-1193 provider such as a
 * Web3Auth/embedded-wallet bridge.
 *
 * The provider must expose a `request(...)` method compatible with
 * `ethers.BrowserProvider`. In production this means the provider must support
 * standard chain/account access, message signing, and transaction submission
 * methods for the flows the SDK will execute.
 */
export async function createSignerFromEip1193Provider(
  provider: Eip1193ProviderLike,
): Promise<ethers.JsonRpcSigner> {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('EIP-1193 provider must expose a request(...) function');
  }

  const browserProvider = new ethers.BrowserProvider(provider);
  return browserProvider.getSigner();
}
