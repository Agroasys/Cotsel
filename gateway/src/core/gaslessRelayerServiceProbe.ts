/**
 * SPDX-License-Identifier: Apache-2.0
 */

export const GASLESS_RELAYER_READINESS_PATH = '/api/relayer/ready';

/**
 * Asks the standalone relayer whether it can sign now (KMS key and replay store). The gateway's
 * own relayer snapshot only describes its local queue and policy, so it cannot see a relayer
 * process, KMS key, or Redis outage until a request has already failed.
 */
export function createGaslessRelayerServiceProbe(
  relayerBaseUrl: string,
  timeoutMs: number,
): () => Promise<void> {
  const url = `${relayerBaseUrl.replace(/\/+$/, '')}${GASLESS_RELAYER_READINESS_PATH}`;

  return async () => {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => null)) as { ready?: unknown } | null;
    if (!response.ok || payload?.ready !== true) {
      throw new Error(`Gasless relayer is not ready (status ${response.status})`);
    }
  };
}
