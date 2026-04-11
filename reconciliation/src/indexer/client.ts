import type { IndexedTradeRecord } from '../types';
import { config } from '../config';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { Logger } from '../utils/logger';

interface GraphQlResponse {
  data?: {
    trades?: Array<{
      tradeId: string;
      buyer: string;
      supplier: string;
      status: string;
      totalAmountLocked: string;
      logisticsAmount: string;
      platformFeesAmount: string;
      supplierFirstTranche: string;
      supplierSecondTranche: string;
      ricardianHash: string;
      createdAt: string;
      arrivalTimestamp?: string | null;
    }>;
  };
  errors?: Array<{ message: string }>;
}

export class IndexerClient {
  constructor(private readonly graphqlUrl: string) {}

  async fetchTrades(limit: number, offset: number): Promise<IndexedTradeRecord[]> {
    const query = `
      query ReconciliationTrades($limit: Int!, $offset: Int!) {
        trades(orderBy: createdAt_ASC, limit: $limit, offset: $offset) {
          tradeId
          buyer
          supplier
          status
          totalAmountLocked
          logisticsAmount
          platformFeesAmount
          supplierFirstTranche
          supplierSecondTranche
          ricardianHash
          createdAt
          arrivalTimestamp
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
        body: JSON.stringify({ query, variables: { limit, offset } }),
      },
      config.indexerGraphqlRequestTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Indexer request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as GraphQlResponse;

    if (body.errors?.length) {
      throw new Error(
        `Indexer GraphQL error: ${body.errors.map((error) => error.message).join('; ')}`,
      );
    }

    const trades = body.data?.trades ?? [];

    Logger.info('Fetched indexed trades batch', { limit, offset, count: trades.length });

    return trades.map((trade) => ({
      tradeId: trade.tradeId,
      buyer: trade.buyer,
      supplier: trade.supplier,
      status: trade.status,
      totalAmountLocked: BigInt(trade.totalAmountLocked),
      logisticsAmount: BigInt(trade.logisticsAmount),
      platformFeesAmount: BigInt(trade.platformFeesAmount),
      supplierFirstTranche: BigInt(trade.supplierFirstTranche),
      supplierSecondTranche: BigInt(trade.supplierSecondTranche),
      ricardianHash: trade.ricardianHash,
      createdAt: new Date(trade.createdAt),
      arrivalTimestamp: trade.arrivalTimestamp ? new Date(trade.arrivalTimestamp) : null,
    }));
  }
}
