import { config } from '../config';
import { IndexerClient } from '../indexer/client';
import {
  getIngestionOffset,
  setIngestionOffset,
  upsertLedgerEntryWithInitialState,
  upsertTreasuryClaimEvent,
} from '../database/queries';
import { Logger } from '../utils/logger';

function buildEntryKey(eventId: string, component: 'LOGISTICS' | 'PLATFORM_FEE'): string {
  return `${eventId}:${component.toLowerCase()}`;
}

const TRADE_EVENT_CURSOR = 'trade_events';
const CLAIM_EVENT_CURSOR = 'claim_events';

export class TreasuryIngestionService {
  private readonly indexerClient = new IndexerClient(config.indexerGraphqlUrl);

  async ingestOnce(): Promise<{ fetched: number; inserted: number }> {
    let tradeOffset = await getIngestionOffset(TRADE_EVENT_CURSOR);
    let claimOffset = await getIngestionOffset(CLAIM_EVENT_CURSOR);
    let fetched = 0;
    let inserted = 0;

    while (fetched < config.ingestMaxEvents) {
      const remaining = config.ingestMaxEvents - fetched;
      const limit = Math.min(config.ingestBatchSize, remaining);

      const events = await this.indexerClient.fetchTreasuryEvents(limit, tradeOffset);
      if (events.length === 0) {
        break;
      }

      for (const event of events) {
        fetched += 1;

        if (event.eventName === 'FundsReleasedStage1' && event.releasedLogisticsAmount) {
          if (!event.txHash) {
            Logger.warn('Skipping logistics ledger entry because txHash is unavailable', {
              eventId: event.id,
              tradeId: event.tradeId,
            });
            continue;
          }

          const { initialStateCreated } = await upsertLedgerEntryWithInitialState({
            entryKey: buildEntryKey(event.id, 'LOGISTICS'),
            tradeId: event.tradeId,
            txHash: event.txHash,
            blockNumber: event.blockNumber,
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
            continue;
          }

          const { initialStateCreated } = await upsertLedgerEntryWithInitialState({
            entryKey: buildEntryKey(event.id, 'PLATFORM_FEE'),
            tradeId: event.tradeId,
            txHash: event.txHash,
            blockNumber: event.blockNumber,
            eventName: event.eventName,
            componentType: 'PLATFORM_FEE',
            amountRaw: event.paidPlatformFees,
            sourceTimestamp: event.timestamp,
            metadata: { sourceEventId: event.id },
          });

          if (initialStateCreated) {
            inserted += 1;
          }
        }
      }

      tradeOffset += events.length;
      if (events.length < limit) {
        break;
      }
    }

    const claimEventFetcher = (
      this.indexerClient as unknown as {
        fetchTreasuryClaimEvents?: (
          limit: number,
          offset: number,
        ) => Promise<
          Array<{
            id: string;
            txHash: string;
            blockNumber: number;
            timestamp: Date;
            claimAmount: string;
            treasuryIdentity: string;
            payoutReceiver: string;
            triggeredBy: string | null;
          }>
        >;
      }
    ).fetchTreasuryClaimEvents;

    if (claimEventFetcher) {
      while (fetched < config.ingestMaxEvents) {
        const remaining = config.ingestMaxEvents - fetched;
        const limit = Math.min(config.ingestBatchSize, remaining);

        const events = await claimEventFetcher.call(this.indexerClient, limit, claimOffset);
        if (events.length === 0) {
          break;
        }

        for (const event of events) {
          fetched += 1;
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

        claimOffset += events.length;
        if (events.length < limit) {
          break;
        }
      }
    }

    await setIngestionOffset(tradeOffset, TRADE_EVENT_CURSOR);
    await setIngestionOffset(claimOffset, CLAIM_EVENT_CURSOR);

    Logger.info('Treasury ingestion run completed', {
      fetched,
      inserted,
      nextTradeOffset: tradeOffset,
      nextClaimOffset: claimOffset,
    });

    return { fetched, inserted };
  }
}
