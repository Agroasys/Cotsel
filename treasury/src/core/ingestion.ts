import { splitPlatformFeeComponents } from '@agroasys/sdk';
import { config } from '../config';
import { IndexerClient } from '../indexer/client';
import {
  getIngestionWatermark,
  setIngestionWatermark,
  upsertLedgerEntryWithInitialState,
  upsertTreasuryClaimEvent,
} from '../database/queries';
import { ChainCanonicalityVerifier, type SettlementChainReader } from './chainCanonicality';
import { createSettlementProvider } from './settlementProvider';
import { Logger } from '../utils/logger';
import type { IndexerTradeEvent } from '../indexer/types';
import type { TreasuryComponent } from '../types';

function buildEntryKey(eventId: string, component: TreasuryComponent): string {
  return `${eventId}:${component.toLowerCase()}`;
}

function resolvePlatformFeeSplit(event: {
  paidPlatformFees: string;
  paidPlatformFeeNet?: string | null;
  paidSettlementSupportFee?: string | null;
}): { platformFeeNetAmount: bigint; settlementSupportFeeAmount: bigint } {
  if (event.paidPlatformFeeNet && event.paidSettlementSupportFee) {
    return {
      platformFeeNetAmount: BigInt(event.paidPlatformFeeNet),
      settlementSupportFeeAmount: BigInt(event.paidSettlementSupportFee),
    };
  }

  return splitPlatformFeeComponents(BigInt(event.paidPlatformFees));
}

export const TRADE_EVENT_CURSOR = 'trade_events';
export const CLAIM_EVENT_CURSOR = 'claim_events';
/** Both cursors advance in the same run, so freshness is judged across both. */
export const INGESTION_CURSORS = [TRADE_EVENT_CURSOR, CLAIM_EVENT_CURSOR];

export interface TreasuryIngestionResult {
  fetched: number;
  inserted: number;
  /** The finalized head the run was bounded by, and the anchor for its evidence. */
  stableBlockNumber: number | null;
  /** The highest block the indexer had processed when the run started. */
  indexerProcessedBlockNumber: number | null;
  /**
   * The height this run actually read through -- the lower of the two cursors,
   * not the window it was aiming at. A run capped by `TREASURY_INGEST_MAX_EVENTS`
   * stops below `toBlock`, and reporting the target here would claim coverage of
   * a range nothing read.
   */
  ingestedThroughBlockNumber: number | null;
  /**
   * Whether both cursors reached the end of the bounded window. A run can
   * succeed without exhausting it, which is progress but not coverage: only an
   * exhausted window may advance the freshness watermark.
   */
  windowExhausted: boolean;
  nextTradeBlockNumber: number;
  nextClaimBlockNumber: number;
  /** Set when the run refused to ingest; `fetched` is then 0 by construction. */
  blockedReason: string | null;
}

/**
 * The resume height is the first block not fully consumed, so coverage is
 * everything strictly below it. A cursor still at 0 has proved nothing, which
 * is `null` rather than block 0.
 */
function provenCoverage(nextBlockNumber: number): number | null {
  return nextBlockNumber > 0 ? nextBlockNumber - 1 : null;
}

/** Both cursors advance in one run, so the weaker one bounds the run's claim. */
function lowestCoverage(first: number | null, second: number | null): number | null {
  if (first === null || second === null) {
    return null;
  }

  return Math.min(first, second);
}

interface WindowOutcome {
  fetched: number;
  inserted: number;
  nextBlockNumber: number;
}

/**
 * WP-4 B-08 / FAIL-06.
 *
 * Two properties this service did not have. It read the indexer's whole event
 * set through a row offset, so it accepted evidence from blocks the chain had
 * not finalized and could still reorganize; and when a reorganization removed
 * events below that offset, every later event shifted down into the range the
 * cursor had already passed and was never ingested.
 *
 * Ingestion is now bounded above by the finalized head and resumed from a block
 * height. Every entry also stores the block hash and log index that identify the
 * event on the chain, which is what `TreasuryEligibilityService` re-derives
 * before export or handoff. Ingestion deliberately does not promote an entry to
 * CANONICAL: it records the identity, the verifier assigns the verdict.
 */
export class TreasuryIngestionService {
  private readonly indexerClient = new IndexerClient(config.indexerGraphqlUrl);
  private readonly verifier: ChainCanonicalityVerifier;

  constructor(deps?: { verifier?: ChainCanonicalityVerifier }) {
    this.verifier =
      deps?.verifier ??
      new ChainCanonicalityVerifier({
        provider: createSettlementProvider() as unknown as SettlementChainReader | null,
      });
  }

  async ingestOnce(): Promise<TreasuryIngestionResult> {
    // One consistent view of the chain per run. A memo carried across runs
    // would let a later run decide against a head that has since moved, which
    // is the class of mistake this whole change exists to remove.
    this.verifier.resetCache();

    const tradeWatermark = await getIngestionWatermark(TRADE_EVENT_CURSOR);
    const claimWatermark = await getIngestionWatermark(CLAIM_EVENT_CURSOR);

    const head = await this.verifier.resolveStableHead();
    if (!head) {
      // Fail closed. Without a finalized head there is no bound that keeps
      // reorganizable evidence out, and ingesting past it is exactly the defect.
      return this.blocked(
        'Settlement RPC did not report a finalized head; ingestion is bounded by finality and will not run unbounded',
        { tradeWatermark, claimWatermark, stableBlockNumber: null, indexerProcessed: null },
      );
    }

    // An empty page is not proof of coverage. The indexer can be behind the
    // finalized head, in which case a query bounded only by the chain returns a
    // short page for blocks it has not reached, and advancing past them would
    // drop every fee event indexed afterwards. The run is therefore bounded by
    // whichever side is further behind, and refuses to run at all if the
    // indexer cannot say where it has reached.
    const indexerProcessed = await this.indexerClient.fetchProcessedBlock();
    if (indexerProcessed === null) {
      return this.blocked(
        'Indexer did not report a processed block height; an empty page cannot be distinguished from an unindexed range',
        {
          tradeWatermark,
          claimWatermark,
          stableBlockNumber: head.finalizedBlockNumber,
          indexerProcessed: null,
        },
      );
    }

    const toBlock = Math.min(head.finalizedBlockNumber, indexerProcessed);
    const trades = await this.ingestTradeEvents(tradeWatermark, toBlock);
    const claims = await this.ingestClaimEvents(claimWatermark, toBlock);

    // Coverage is derived from where each cursor actually landed, never from
    // the window the run was aiming at. The resume height is the first block
    // not fully consumed, so everything strictly below it was read whole --
    // which holds for all three ways a window loop ends: exhaustion, the event
    // cap, and a stop on an unresolvable block.
    const tradeCoverage = provenCoverage(trades.nextBlockNumber);
    const claimCoverage = provenCoverage(claims.nextBlockNumber);

    await setIngestionWatermark(trades.nextBlockNumber, TRADE_EVENT_CURSOR, tradeCoverage);
    await setIngestionWatermark(claims.nextBlockNumber, CLAIM_EVENT_CURSOR, claimCoverage);

    const result: TreasuryIngestionResult = {
      fetched: trades.fetched + claims.fetched,
      inserted: trades.inserted + claims.inserted,
      stableBlockNumber: head.finalizedBlockNumber,
      indexerProcessedBlockNumber: indexerProcessed,
      ingestedThroughBlockNumber: lowestCoverage(tradeCoverage, claimCoverage),
      windowExhausted: trades.nextBlockNumber > toBlock && claims.nextBlockNumber > toBlock,
      nextTradeBlockNumber: trades.nextBlockNumber,
      nextClaimBlockNumber: claims.nextBlockNumber,
      blockedReason: null,
    };

    Logger.info('Treasury ingestion run completed', { ...result });
    return result;
  }

  private blocked(
    blockedReason: string,
    state: {
      tradeWatermark: number;
      claimWatermark: number;
      stableBlockNumber: number | null;
      indexerProcessed: number | null;
    },
  ): TreasuryIngestionResult {
    Logger.error('Treasury ingestion blocked', { blockedReason, ...state });
    return {
      fetched: 0,
      inserted: 0,
      stableBlockNumber: state.stableBlockNumber,
      indexerProcessedBlockNumber: state.indexerProcessed,
      ingestedThroughBlockNumber: null,
      windowExhausted: false,
      nextTradeBlockNumber: state.tradeWatermark,
      nextClaimBlockNumber: state.claimWatermark,
      blockedReason,
    };
  }

  /**
   * Pages a closed `[fromBlock, toBlock]` range. An offset is safe here and only
   * here: the range is pinned to a finalized head for the length of the run, so
   * the set being paged cannot change underneath it. What is persisted between
   * runs is never the offset, only a block height.
   */
  private async ingestTradeEvents(fromBlock: number, toBlock: number): Promise<WindowOutcome> {
    let fetched = 0;
    let inserted = 0;
    let offset = 0;
    let lastBlockNumber: number | null = null;
    let exhausted = false;
    let stoppedAtBlock: number | null = null;

    while (fromBlock <= toBlock) {
      const limit = config.ingestBatchSize;
      const events = await this.indexerClient.fetchTreasuryEvents({
        limit,
        offset,
        fromBlock,
        toBlock,
      });

      if (events.length === 0) {
        exhausted = true;
        break;
      }

      for (const event of events) {
        const blockHash = await this.verifier.resolveBlockHash(event.blockNumber);
        if (!blockHash) {
          // The chain cannot tell us what block this height holds, so the event
          // has no identity to store. Stop here rather than writing a row that
          // can never be verified, and resume from this block next run.
          Logger.error('Treasury ingestion stopped: canonical block hash is unavailable', {
            blockNumber: event.blockNumber,
            eventId: event.id,
          });
          stoppedAtBlock = event.blockNumber;
          break;
        }

        fetched += 1;
        lastBlockNumber = event.blockNumber;
        // Identity is captured here, not asserted later: the emitter and the
        // log's content digest are what a re-verification has to reproduce.
        // A log we cannot read is stored without one, which leaves the entry
        // UNVERIFIED and therefore unpayable rather than silently trusted.
        const logIdentity = event.txHash
          ? await this.verifier.resolveLogIdentity(event.txHash, event.logIndex)
          : null;

        inserted += await this.ingestTradeEvent(event, blockHash, logIdentity);
      }

      if (stoppedAtBlock !== null) {
        break;
      }

      offset += events.length;

      if (events.length < limit) {
        exhausted = true;
        break;
      }

      // The cap bounds a run, but it must never split a block: stopping mid
      // block and resuming at the next height would drop the remainder. The
      // watermark is a height, so a block is consumed whole or re-read whole.
      if (fetched >= config.ingestMaxEvents && lastBlockNumber !== fromBlock) {
        break;
      }
    }

    return {
      fetched,
      inserted,
      nextBlockNumber: this.resolveNextBlock({
        fromBlock,
        toBlock,
        lastBlockNumber,
        exhausted,
        stoppedAtBlock,
      }),
    };
  }

  private async ingestTradeEvent(
    event: IndexerTradeEvent,
    blockHash: string,
    logIdentity: { address: string; identityHash: string } | null,
  ): Promise<number> {
    let inserted = 0;

    if (event.eventName === 'FundsReleasedStage1' && event.releasedLogisticsAmount) {
      if (!event.txHash) {
        Logger.warn('Skipping logistics ledger entry because txHash is unavailable', {
          eventId: event.id,
          tradeId: event.tradeId,
        });
        return inserted;
      }

      const { initialStateCreated } = await upsertLedgerEntryWithInitialState({
        entryKey: buildEntryKey(event.id, 'LOGISTICS'),
        tradeId: event.tradeId,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
        blockHash,
        logIndex: event.logIndex,
        logAddress: logIdentity?.address ?? null,
        logIdentityHash: logIdentity?.identityHash ?? null,
        eventName: event.eventName,
        componentType: 'LOGISTICS',
        amountRaw: event.releasedLogisticsAmount,
        sourceTimestamp: event.timestamp,
        metadata: { sourceEventId: event.id },
      });

      if (initialStateCreated) {
        inserted += 1;
      }
    }

    if (event.eventName === 'PlatformFeesPaidStage1' && event.paidPlatformFees) {
      if (!event.txHash) {
        Logger.warn('Skipping platform fee ledger entry because txHash is unavailable', {
          eventId: event.id,
          tradeId: event.tradeId,
        });
        return inserted;
      }

      const { platformFeeNetAmount, settlementSupportFeeAmount } = resolvePlatformFeeSplit({
        paidPlatformFees: event.paidPlatformFees,
        paidPlatformFeeNet: event.paidPlatformFeeNet,
        paidSettlementSupportFee: event.paidSettlementSupportFee,
      });
      const grossPlatformFeesAmount = BigInt(event.paidPlatformFees);
      const platformEntries = [
        {
          componentType: 'PLATFORM_FEE',
          amountRaw: platformFeeNetAmount.toString(),
          metadata: {
            sourceEventId: event.id,
            grossPlatformFeesAmount: grossPlatformFeesAmount.toString(),
            settlementSupportFeeAmount: settlementSupportFeeAmount.toString(),
          },
        },
        {
          componentType: 'SETTLEMENT_SUPPORT_FEE',
          amountRaw: settlementSupportFeeAmount.toString(),
          metadata: {
            sourceEventId: event.id,
            grossPlatformFeesAmount: grossPlatformFeesAmount.toString(),
            platformFeeNetAmount: platformFeeNetAmount.toString(),
          },
        },
      ] satisfies Array<{
        componentType: TreasuryComponent;
        amountRaw: string;
        metadata: Record<string, unknown>;
      }>;

      for (const entry of platformEntries) {
        if (BigInt(entry.amountRaw) <= 0n) {
          continue;
        }

        const { initialStateCreated } = await upsertLedgerEntryWithInitialState({
          entryKey: buildEntryKey(event.id, entry.componentType),
          tradeId: event.tradeId,
          txHash: event.txHash,
          blockNumber: event.blockNumber,
          blockHash,
          logIndex: event.logIndex,
          logAddress: logIdentity?.address ?? null,
          logIdentityHash: logIdentity?.identityHash ?? null,
          eventName: event.eventName,
          componentType: entry.componentType,
          amountRaw: entry.amountRaw,
          sourceTimestamp: event.timestamp,
          metadata: entry.metadata,
        });

        if (initialStateCreated) {
          inserted += 1;
        }
      }
    }

    return inserted;
  }

  private async ingestClaimEvents(fromBlock: number, toBlock: number): Promise<WindowOutcome> {
    let fetched = 0;
    let offset = 0;
    let lastBlockNumber: number | null = null;
    let exhausted = false;

    while (fromBlock <= toBlock) {
      const limit = config.ingestBatchSize;
      const claimEvents = await this.indexerClient.fetchTreasuryClaimEvents({
        limit,
        offset,
        fromBlock,
        toBlock,
      });

      if (claimEvents.length === 0) {
        exhausted = true;
        break;
      }

      for (const event of claimEvents) {
        fetched += 1;
        lastBlockNumber = event.blockNumber;
        await upsertTreasuryClaimEvent({
          sourceEventId: event.id,
          matchedSweepBatchId: null,
          txHash: event.txHash,
          blockNumber: event.blockNumber,
          observedAt: event.timestamp,
          treasuryIdentity: event.treasuryIdentity,
          payoutReceiver: event.payoutReceiver,
          amountRaw: event.claimAmount,
          triggeredBy: event.triggeredBy,
        });
      }

      offset += claimEvents.length;

      if (claimEvents.length < limit) {
        exhausted = true;
        break;
      }

      if (fetched >= config.ingestMaxEvents && lastBlockNumber !== fromBlock) {
        break;
      }
    }

    return {
      fetched,
      inserted: 0,
      nextBlockNumber: this.resolveNextBlock({
        fromBlock,
        toBlock,
        lastBlockNumber,
        exhausted,
        stoppedAtBlock: null,
      }),
    };
  }

  /**
   * A partly consumed block is re-read rather than stepped over. Re-reading is
   * free of consequence because `entry_key` makes every upsert idempotent,
   * whereas stepping over loses whatever the run did not reach.
   */
  private resolveNextBlock(input: {
    fromBlock: number;
    toBlock: number;
    lastBlockNumber: number | null;
    exhausted: boolean;
    stoppedAtBlock: number | null;
  }): number {
    if (input.stoppedAtBlock !== null) {
      return input.stoppedAtBlock;
    }

    if (input.exhausted) {
      return Math.max(input.fromBlock, input.toBlock + 1);
    }

    return input.lastBlockNumber ?? input.fromBlock;
  }
}
