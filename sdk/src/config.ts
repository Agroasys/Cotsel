/**
 * SPDX-License-Identifier: Apache-2.0
 */
export interface Config {
  // network
  rpc: string;
  rpcFallbackUrls?: string[];
  chainId: number;

  // RPC failover tuning (optional; defaults keep liveness-first behavior)
  /** Provider agreement required for reads. Defaults to 1 (first answer wins). Clamped to provider count. */
  rpcQuorum?: number;
  /** Per-provider stall timeout before failover, in ms. Defaults to 1500. */
  rpcStallTimeoutMs?: number;

  // contracts
  escrowAddress: string;
  usdcAddress: string;
}
