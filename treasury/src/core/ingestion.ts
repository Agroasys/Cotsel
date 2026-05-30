import { splitPlatformFeeComponents } from '@agroasys/sdk';
import { config } from '../config';
import { IndexerClient } from '../indexer/client';
import {
  getIngestionOffset,
  setIngestionOffset,
  upsertLedgerEntryWithInitialState,
  upsertTreasuryClaimEvent,
} from '../database/queries';
import { Logger } from '../utils/logger';
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
