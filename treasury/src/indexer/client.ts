import { IndexerTradeEvent } from '../types';
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
}
