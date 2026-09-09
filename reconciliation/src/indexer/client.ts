import type { IndexedTradeRecord } from '../types';
import { config } from '../config';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { Logger } from '../utils/logger';

const TRADE_FIELDS = `
  tradeId
  buyer
  supplier
  status
  totalAmountLocked
  logisticsAmount
  platformFeesAmount
  platformFeeNetAmount
  settlementSupportFeeAmount
  supplierFirstTranche
  supplierSecondTranche
  ricardianHash
  createdAt
  arrivalTimestamp
`;

interface GraphQlResponse {
  data?: {
    tradesConnection?: { totalCount?: number };
    trades?: Array<{
      tradeId: string;
      buyer: string;
      supplier: string;
      status: string;
      totalAmountLocked: string;
      logisticsAmount: string;
      platformFeesAmount: string;
      platformFeeNetAmount: string;
      settlementSupportFeeAmount: string;
      supplierFirstTranche: string;
      supplierSecondTranche: string;
      ricardianHash: string;
      createdAt: string;
      arrivalTimestamp?: string | null;
    }>;
  };
  errors?: Array<{ message: string }>;
}

type RawIndexedTrade = NonNullable<NonNullable<GraphQlResponse['data']>['trades']>[number];

function toIndexedTradeRecord(trade: RawIndexedTrade): IndexedTradeRecord {
  return {
    tradeId: trade.tradeId,
    buyer: trade.buyer,
    supplier: trade.supplier,
    status: trade.status,
    totalAmountLocked: BigInt(trade.totalAmountLocked),
    logisticsAmount: BigInt(trade.logisticsAmount),
    platformFeesAmount: BigInt(trade.platformFeesAmount),
    platformFeeNetAmount: BigInt(trade.platformFeeNetAmount),
    settlementSupportFeeAmount: BigInt(trade.settlementSupportFeeAmount),
    supplierFirstTranche: BigInt(trade.supplierFirstTranche),
    supplierSecondTranche: BigInt(trade.supplierSecondTranche),
    ricardianHash: trade.ricardianHash,
    createdAt: new Date(trade.createdAt),
    arrivalTimestamp: trade.arrivalTimestamp ? new Date(trade.arrivalTimestamp) : null,
  };
}

export class IndexerClient {
  constructor(private readonly graphqlUrl: string) {}

  private async execute(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<NonNullable<GraphQlResponse['data']>> {
    const response = await fetchWithTimeout(
      this.graphqlUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
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

    return body.data ?? {};
  }

  /**
   * Fetch exactly the ids the chain says exist in this window.
   *
   * The chain drives the id set rather than the indexer driving pagination:
   * `Trade.tradeId` is a GraphQL `String`, so range and ordering operators on
   * it are lexicographic ("10" sorts before "9") and cannot express a numeric
   * keyset. Asking for an explicit id set sidesteps that entirely, and any id
   * absent from the response is a chain trade the indexer never projected.
   */
  async fetchTradesByIds(tradeIds: string[]): Promise<IndexedTradeRecord[]> {
    if (tradeIds.length === 0) {
      return [];
    }

    const query = `
      query ReconciliationTradesByIds($tradeIds: [String!]!) {
        trades(where: { tradeId_in: $tradeIds }, limit: ${tradeIds.length}) {
          ${TRADE_FIELDS}
        }
      }
    `;

    const data = await this.execute(query, { tradeIds });
    const trades = data.trades ?? [];

    Logger.info('Fetched indexed trades by id', {
      requested: tradeIds.length,
      returned: trades.length,
    });

    return trades.map(toIndexedTradeRecord);
  }

  /**
   * Total projected trades, used as the cheap indexer-side surplus invariant:
   * the indexer must never hold more trades than the chain has allocated ids.
   */
  async fetchTradeCount(): Promise<number> {
    const query = `
      query ReconciliationTradeCount {
        tradesConnection(orderBy: id_ASC) {
          totalCount
        }
      }
    `;

    const data = await this.execute(query, {});
    return data.tradesConnection?.totalCount ?? 0;
  }
}
