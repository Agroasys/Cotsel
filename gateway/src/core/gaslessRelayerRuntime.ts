/**
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GaslessRelayerBroadcastLock {
  runExclusive<T>(handler: () => Promise<T>): Promise<T>;
}

export function createInProcessGaslessRelayerBroadcastLock(): GaslessRelayerBroadcastLock {
  return { runExclusive: (handler) => handler() };
}
