/**
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GaslessRelayerBroadcastLock {
  runExclusive<T>(handler: () => Promise<T>): Promise<T>;
}

export function createInProcessGaslessRelayerBroadcastLock(): GaslessRelayerBroadcastLock {
  let queue: Promise<void> = Promise.resolve();
  return {
    runExclusive<T>(handler: () => Promise<T>): Promise<T> {
      const run = queue.then(handler);
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
