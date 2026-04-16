import { IndexerTradeEvent, IndexerTreasuryClaimEvent } from '../types';
import { config } from '../config';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

interface GraphQlResponse {
  data?: {
    tradeEvents?: Array<{
      id: string;
      eventName: string;
      txHash: string | null;
      blockNumber: number;
      timestamp: string;
      releasedLogisticsAmount?: string | null;
      paidPlatformFees?: string | null;
      trade: {
        tradeId: string;
      };
    }>;
    systemEvents?: Array<{
      id: string;
      eventName: 'TreasuryClaimed';
      txHash: string;
      blockNumber: number;
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

  async fetchTreasuryEvents(limit: number, offset: number): Promise<IndexerTradeEvent[]> {
    const query = `
      query TreasuryEvents($limit: Int!, $offset: Int!) {
        tradeEvents(
          where: { eventName_in: [\"FundsReleasedStage1\", \"PlatformFeesPaidStage1\"] }
          orderBy: blockNumber_ASC
          limit: $limit
          offset: $offset
        ) {
          id
          eventName
          txHash
          blockNumber
          timestamp
          releasedLogisticsAmount
          paidPlatformFees
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
          variables: { limit, offset },
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
      timestamp: new Date(event.timestamp),
      releasedLogisticsAmount: event.releasedLogisticsAmount || null,
      paidPlatformFees: event.paidPlatformFees || null,
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
      timestamp: new Date(event.timestamp),
      claimAmount: event.claimAmount,
      treasuryIdentity: event.treasuryIdentity.toLowerCase(),
      payoutReceiver: event.payoutReceiver.toLowerCase(),
      triggeredBy: event.triggeredBy ? event.triggeredBy.toLowerCase() : null,
    };
  }
}
