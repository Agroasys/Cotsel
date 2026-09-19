import { IndexerTradeEvent, IndexerTreasuryClaimEvent } from './types';
import { config } from '../config';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

/**
 * Ingestion reads a half-open-free, fully closed block range rather than a
 * position in the indexer's result set. `toBlock` is the finalized head the run
 * is anchored to, so a block the indexer adds mid-run cannot widen the window,
 * and `offset` only pages within that fixed range.
 */
export interface IndexerBlockWindow {
  limit: number;
  offset: number;
  fromBlock: number;
  toBlock: number;
}

interface GraphQlResponse {
  data?: {
    overviewSnapshots?: Array<{ lastProcessedBlock?: string | null }>;
    tradeEvents?: Array<{
      id: string;
      eventName: string;
      txHash: string | null;
      blockNumber: number;
      logIndex: number;
      timestamp: string;
      releasedLogisticsAmount?: string | null;
      paidPlatformFees?: string | null;
      paidPlatformFeeNet?: string | null;
      paidSettlementSupportFee?: string | null;
      trade: {
        tradeId: string;
      };
    }>;
    systemEvents?: Array<{
      id: string;
      eventName: 'TreasuryClaimed';
      txHash: string;
      blockNumber: number;
      logIndex: number;
      timestamp: string;
      claimAmount: string | null;
      treasuryIdentity: string | null;
      payoutReceiver: string | null;
      triggeredBy: string | null;
    }>;
  };
  errors?: Array<{ message: string }>;
}

export class IndexerClient {
  constructor(private readonly graphqlUrl: string) {}

  /**
   * The highest block the indexer has actually processed.
   *
   * Ingestion needs this because an empty page proves nothing on its own: if
   * the finalized chain head is ahead of the indexer, a query bounded only by
   * the chain returns a short page for a range the indexer has not reached yet,
   * and advancing the watermark past it drops every fee event indexed later.
   * The window is therefore bounded by whichever of the two is behind.
   */
  async fetchProcessedBlock(): Promise<number | null> {
    const query = `
      query TreasuryIndexerProcessedBlock {
        overviewSnapshots(limit: 1, orderBy: lastProcessedBlock_DESC) {
          lastProcessedBlock
        }
      }
    `;

    const response = await fetchWithTimeout(
      this.graphqlUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: {} }),
      },
      config.indexerGraphqlRequestTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Indexer GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as GraphQlResponse;
    if (body.errors?.length) {
      throw new Error(
        `Indexer GraphQL errors: ${body.errors.map((item) => item.message).join('; ')}`,
      );
    }

    const raw = body.data?.overviewSnapshots?.[0]?.lastProcessedBlock;
    if (raw === undefined || raw === null) {
      return null;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async fetchTreasuryEvents(window: IndexerBlockWindow): Promise<IndexerTradeEvent[]> {
    const query = `
      query TreasuryEvents($limit: Int!, $offset: Int!, $fromBlock: Int!, $toBlock: Int!) {
        tradeEvents(
          where: {
            eventName_in: [\"FundsReleasedStage1\", \"PlatformFeesPaidStage1\"]
            blockNumber_gte: $fromBlock
            blockNumber_lte: $toBlock
          }
          orderBy: [blockNumber_ASC, logIndex_ASC]
          limit: $limit
          offset: $offset
        ) {
          id
          eventName
          txHash
          blockNumber
          logIndex
          timestamp
          releasedLogisticsAmount
          paidPlatformFees
          paidPlatformFeeNet
          paidSettlementSupportFee
          trade {
            tradeId
          }
        }
      }
    `;

    const response = await fetchWithTimeout(
      this.graphqlUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            limit: window.limit,
            offset: window.offset,
            fromBlock: window.fromBlock,
            toBlock: window.toBlock,
          },
        }),
      },
      config.indexerGraphqlRequestTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Indexer GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as GraphQlResponse;

    if (body.errors?.length) {
      throw new Error(
        `Indexer GraphQL errors: ${body.errors.map((item) => item.message).join('; ')}`,
      );
    }

    const events = body.data?.tradeEvents || [];

    return events.map((event) => ({
      id: event.id,
      tradeId: event.trade.tradeId,
      eventName: event.eventName,
      txHash: event.txHash ?? null,
      blockNumber: Number(event.blockNumber),
      logIndex: Number(event.logIndex),
      timestamp: new Date(event.timestamp),
      releasedLogisticsAmount: event.releasedLogisticsAmount || null,
      paidPlatformFees: event.paidPlatformFees || null,
      paidPlatformFeeNet: event.paidPlatformFeeNet || null,
      paidSettlementSupportFee: event.paidSettlementSupportFee || null,
    }));
  }

  async fetchTreasuryClaimEventByTxHash(txHash: string): Promise<IndexerTreasuryClaimEvent | null> {
    const query = `
      query TreasuryClaimEvent($txHash: String!) {
        systemEvents(
          where: { eventName_eq: "TreasuryClaimed", txHash_eq: $txHash }
          orderBy: blockNumber_ASC
          limit: 2
        ) {
          id
          eventName
          txHash
          blockNumber
          logIndex
          timestamp
          claimAmount
          treasuryIdentity
          payoutReceiver
          triggeredBy
        }
      }
    `;

    const response = await fetchWithTimeout(
      this.graphqlUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: { txHash },
        }),
      },
      config.indexerGraphqlRequestTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Indexer GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as GraphQlResponse;

    if (body.errors?.length) {
      throw new Error(
        `Indexer GraphQL errors: ${body.errors.map((item) => item.message).join('; ')}`,
      );
    }

    const events = body.data?.systemEvents || [];
    if (events.length === 0) {
      return null;
    }

    if (events.length > 1) {
      throw new Error(`Expected a single TreasuryClaimed event for tx ${txHash}`);
    }

    const event = events[0];
    if (!event.claimAmount || !event.treasuryIdentity || !event.payoutReceiver) {
      throw new Error(`TreasuryClaimed event for tx ${txHash} is missing required fields`);
    }

    return {
      id: event.id,
      eventName: event.eventName,
      txHash: event.txHash,
      blockNumber: Number(event.blockNumber),
      logIndex: Number(event.logIndex),
      timestamp: new Date(event.timestamp),
      claimAmount: event.claimAmount,
      treasuryIdentity: event.treasuryIdentity.toLowerCase(),
      payoutReceiver: event.payoutReceiver.toLowerCase(),
      triggeredBy: event.triggeredBy ? event.triggeredBy.toLowerCase() : null,
    };
  }

  async fetchTreasuryClaimEvents(window: IndexerBlockWindow): Promise<IndexerTreasuryClaimEvent[]> {
    const query = `
      query TreasuryClaimEvents($limit: Int!, $offset: Int!, $fromBlock: Int!, $toBlock: Int!) {
        systemEvents(
          where: {
            eventName_eq: "TreasuryClaimed"
            blockNumber_gte: $fromBlock
            blockNumber_lte: $toBlock
          }
          orderBy: [blockNumber_ASC, logIndex_ASC]
          limit: $limit
          offset: $offset
        ) {
          id
          eventName
          txHash
          blockNumber
          logIndex
          timestamp
          claimAmount
          treasuryIdentity
          payoutReceiver
          triggeredBy
        }
      }
    `;

    const response = await fetchWithTimeout(
      this.graphqlUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            limit: window.limit,
            offset: window.offset,
            fromBlock: window.fromBlock,
            toBlock: window.toBlock,
          },
        }),
      },
      config.indexerGraphqlRequestTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Indexer GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as GraphQlResponse;

    if (body.errors?.length) {
      throw new Error(
        `Indexer GraphQL errors: ${body.errors.map((item) => item.message).join('; ')}`,
      );
    }

    const events = body.data?.systemEvents || [];
    return events
      .filter((event) => event.claimAmount && event.treasuryIdentity && event.payoutReceiver)
      .map((event) => ({
        id: event.id,
        eventName: event.eventName,
        txHash: event.txHash,
        blockNumber: Number(event.blockNumber),
        logIndex: Number(event.logIndex),
        timestamp: new Date(event.timestamp),
        claimAmount: event.claimAmount as string,
        treasuryIdentity: (event.treasuryIdentity as string).toLowerCase(),
        payoutReceiver: (event.payoutReceiver as string).toLowerCase(),
        triggeredBy: event.triggeredBy ? event.triggeredBy.toLowerCase() : null,
      }));
  }
}
