/**
 * SPDX-License-Identifier: Apache-2.0
 */

export function isGaslessNonceDriftError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  if (code === 'NONCE_EXPIRED') return true;

  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('nonce too low') ||
    message.includes('nonce has already been used') ||
    message.includes('replacement fee too low')
  );
}

export interface GaslessRelayerBroadcastLock {
  runExclusive<T>(handler: () => Promise<T>): Promise<T>;
}

export function createInProcessGaslessRelayerBroadcastLock(): GaslessRelayerBroadcastLock {
  return { runExclusive: (handler) => handler() };
}
