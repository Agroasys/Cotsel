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
    overviewSnapshots?: Array<{ lastProcessedBlock?: string | null }>;
    tradeIds?: Array<{ tradeId: string }>;
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

  /**
   * The block the indexer has actually processed.
   *
   * A run anchors every chain read to this height. The chain can be read at any
   * historical block, but the indexer only ever reports its *current* state, so
   * the one block both sides can describe is the block the indexer has reached.
   * Reading the chain anywhere else (e.g. a deeper finalized block while the
   * indexer runs closer to head) makes the indexer's lead read as field drift or
   * a surplus that does not exist.
   */
  async fetchProcessedBlock(): Promise<number | null> {
    const query = `
      query ReconciliationIndexerProcessedBlock {
        overviewSnapshots(limit: 1, orderBy: lastProcessedBlock_DESC) {
          lastProcessedBlock
        }
      }
    `;

    const data = await this.execute(query, {});
    const raw = data.overviewSnapshots?.[0]?.lastProcessedBlock;
    if (raw === undefined || raw === null) {
      return null;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Enumerate the indexer's own trade ids, independent of any chain-derived id
   * set.
   *
   * `fetchTradesByIds` can only echo back ids from its `tradeId_in` filter, so
   * it can never surface a record the chain never allocated — the indexer-only
   * direction is unreachable through it. This walks the indexer's projection on
   * its own terms (offset pagination over `id`) so an id beyond the chain
   * counter, or a numeric surplus that a raw count would mask by cancelling
   * against a missing id, is observed directly.
   *
   * Bounded by `maxIds`: a fully enumerated page shorter than the limit means
   * the walk is complete; `truncated` flags when it was not, so the caller can
   * surface that rather than treat a partial walk as exhaustive.
   */
  async fetchTradeIds(
    maxIds: number,
    pageSize: number,
  ): Promise<{ tradeIds: string[]; truncated: boolean }> {
    if (maxIds <= 0 || pageSize <= 0) {
      throw new Error('fetchTradeIds requires positive maxIds and pageSize');
    }

    const query = `
      query ReconciliationTradeIds($limit: Int!, $offset: Int!) {
        tradeIds: trades(limit: $limit, offset: $offset, orderBy: id_ASC) {
          tradeId
        }
      }
    `;

    const tradeIds: string[] = [];
    let offset = 0;

    for (;;) {
      const limit = Math.min(pageSize, maxIds - tradeIds.length);
      if (limit <= 0) {
        return { tradeIds, truncated: true };
      }

      const data = await this.execute(query, { limit, offset });
      const page = data.tradeIds ?? [];
      tradeIds.push(...page.map((row) => row.tradeId));

      if (page.length < limit) {
        return { tradeIds, truncated: false };
      }
      offset += page.length;
    }
  }
}
