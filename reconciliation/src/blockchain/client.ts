import { OracleSDK, type CoverageBoundaryPreference, type Trade } from '@agroasys/sdk';
import { config } from '../config';
import type { CoverageBoundary } from '../types';

/**
 * Chain-side read surface for reconciliation.
 *
 * The chain is the independent enumeration authority: trade ids are allocated
 * sequentially from 1 up to `tradeCounter`, so the contract alone defines the
 * complete id space a run must cover. Nothing here consults the indexer.
 */
export class OnchainClient {
  private readonly sdk: OracleSDK;

  constructor() {
    this.sdk = new OracleSDK({
      rpc: config.rpcUrl,
      rpcFallbackUrls: config.rpcFallbackUrls,
      rpcQuorum: config.rpcQuorum,
      rpcStallTimeoutMs: config.rpcStallTimeoutMs,
      chainId: config.chainId,
      escrowAddress: config.escrowAddress,
      usdcAddress: config.usdcAddress,
    });
  }

  /**
   * Pin the run to one block and read the trade counter at that same block.
   *
   * Both reads must share a height: a counter read after the trade reads would
   * include trades the sweep never looked at, and a counter read at the head
   * while trades are read at a finalized block would report freshly created
   * trades as missing from the indexer.
   */
  async resolveBoundary(
    preference: CoverageBoundaryPreference = config.coverageBoundary,
  ): Promise<CoverageBoundary> {
    const block = await this.sdk.getCoverageBoundaryBlock(preference);
    const chainTradeCounter = await this.sdk.getTradeCounter(block.number);

    return {
      blockNumber: block.number,
      blockHash: block.hash,
      tag: block.tag,
      chainTradeCounter,
    };
  }

  async getTrade(tradeId: string, blockTag?: number): Promise<Trade> {
    return this.sdk.getTrade(tradeId, { blockTag });
  }
}
