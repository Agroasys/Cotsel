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
    tradeIds?: Array<{ id: string; tradeId: string }>;
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
    const count = data.tradesConnection?.totalCount;
    if (!Number.isSafeInteger(count) || (count as number) < 0)
      throw new Error('Indexer trade count unavailable');
    return count as number;
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

  /** Fixed upper physical identity for one independently enumerated source cycle. */
  async fetchTradeIdUpperBound(): Promise<string | null> {
    const data = await this.execute(
      `query ReconciliationTradeIdUpperBound {
      tradeIds: trades(limit: 1, orderBy: id_DESC) { id tradeId }
    }`,
      {},
    );
    if (!Array.isArray(data.tradeIds)) throw new Error('Indexer identity source unavailable');
    const id = data.tradeIds[0]?.id;
    if (
      data.tradeIds.length > 1 ||
      (id !== undefined && (typeof id !== 'string' || !id || id.length > 1024))
    )
      throw new Error('Invalid indexer identity upper bound');
    return id ?? null;
  }

  /** Physical identity keyset; logical trade IDs are deliberately not deduplicated. */
  async fetchTradeIdsPage(input: {
    afterId: string | null;
    throughId: string | null;
    limit: number;
  }): Promise<{
    records: Array<{ id: string; tradeId: string }>;
    nextId: string | null;
    exhausted: boolean;
  }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100000)
      throw new Error('Invalid indexer keyset limit');
    if (input.throughId === null) return { records: [], nextId: input.afterId, exhausted: true };
    const data = await this.execute(
      `
      query ReconciliationTradeIdsPage($limit: Int!, $afterId: String!, $throughId: String!) {
        tradeIds: trades(limit: $limit, orderBy: id_ASC, where: { id_gt: $afterId, id_lte: $throughId }) { id tradeId }
      }
    `,
      { afterId: input.afterId ?? '', throughId: input.throughId, limit: input.limit + 1 },
    );
    if (!Array.isArray(data.tradeIds) || data.tradeIds.length > input.limit + 1)
      throw new Error('Invalid indexer keyset page');
    let previous = input.afterId ?? '';
    for (const row of data.tradeIds) {
      if (
        typeof row.id !== 'string' ||
        !row.id ||
        row.id.length > 1024 ||
        row.id <= previous ||
        row.id > input.throughId ||
        typeof row.tradeId !== 'string' ||
        !row.tradeId ||
        row.tradeId.length > 255
      )
        throw new Error('Invalid indexer keyset page');
      previous = row.id;
    }
    const records = data.tradeIds.slice(0, input.limit);
    return {
      records,
      nextId: records[records.length - 1]?.id ?? input.afterId,
      exhausted: data.tradeIds.length <= input.limit,
    };
  }
}
