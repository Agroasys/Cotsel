import { OracleSDK, type CoverageBoundaryPreference, type Trade } from '@agroasys/sdk';
import { config } from '../config';
import { anchorBoundaryBlock } from '../core/coverage';
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
   * The block is the one the indexer has processed, not the chain's finalized
   * head: the chain can be read at any historical height, but the indexer only
   * reports its current projection, so the one height both sides can describe is
   * the block the indexer has reached. Reading the counter and every trade at
   * that block keeps a difference real rather than an artefact of the two sides
   * sitting at different heights. The finality preference still resolves a chain
   * boundary, used to flag when the indexer is running ahead of it.
   *
   * The caller must supply a real indexer checkpoint. There is deliberately no
   * fallback to the finality block: substituting one would anchor the run to a
   * height the indexer may never have reached, and the end-of-run snapshot check
   * cannot tell a substituted anchor from a read one. `evaluateIndexerAnchor`
   * gates the run before it gets here.
   */
  async resolveBoundary(
    indexerProcessedBlock: number,
    preference: CoverageBoundaryPreference = config.coverageBoundary,
  ): Promise<CoverageBoundary> {
    const finalityBlock = await this.sdk.getCoverageBoundaryBlock(preference);
    const anchor = anchorBoundaryBlock({
      finalityBlockNumber: finalityBlock.number,
      indexerProcessedBlock,
    });

    // Reuse the finality block's hash when it is already the anchor; otherwise
    // resolve the hash at the indexer's processed height.
    const anchorHash =
      anchor.blockNumber === finalityBlock.number
        ? finalityBlock.hash
        : (await this.sdk.getBlockByNumber(anchor.blockNumber)).hash;

    const chainTradeCounter = await this.sdk.getTradeCounter(anchor.blockNumber);

    return {
      blockNumber: anchor.blockNumber,
      blockHash: anchorHash,
      tag: finalityBlock.tag,
      chainTradeCounter,
      indexerProcessedBlock: anchor.blockNumber,
      finalityBlockNumber: finalityBlock.number,
      indexerAhead: anchor.indexerAhead,
    };
  }

  async getTrade(tradeId: string, blockTag?: number): Promise<Trade> {
    return this.sdk.getTrade(tradeId, { blockTag });
  }
}
