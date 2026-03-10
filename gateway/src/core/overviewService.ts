/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ComplianceStore } from './complianceStore';
import { EscrowGovernanceReader } from './governanceStatusService';
import { GatewayError } from '../errors';

export interface OverviewTradeKpis {
  total: number;
  byStatus: {
    locked: number;
    stage_1: number;
    stage_2: number;
    completed: number;
    disputed: number;
  };
}

export interface OverviewFeedStatus {
  source: string;
  queriedAt: string | null;
  available: boolean;
}

export interface OverviewPosture {
  paused: boolean;
  claimsPaused: boolean;
  oracleActive: boolean;
}

export interface OverviewSnapshot {
  kpis: {
    trades: OverviewTradeKpis;
    compliance: { blockedTrades: number };
  };
  posture: OverviewPosture | null;
  feedFreshness: {
    trades: OverviewFeedStatus;
    governance: OverviewFeedStatus;
    compliance: OverviewFeedStatus;
  };
}

export interface OverviewReader {
  getOverview(): Promise<OverviewSnapshot>;
}

interface TradeStatusRecord {
  tradeId: string;
  status: 'LOCKED' | 'IN_TRANSIT' | 'ARRIVAL_CONFIRMED' | 'FROZEN' | 'CLOSED';
}

interface TradeStatusGraphQlResponse {
  data?: { trades?: TradeStatusRecord[] };
  errors?: Array<{ message: string }>;
}

const OVERVIEW_TRADE_FETCH_LIMIT = 1000;
const EMPTY_TRADE_KPIS: OverviewTradeKpis = {
  total: 0,
  byStatus: { locked: 0, stage_1: 0, stage_2: 0, completed: 0, disputed: 0 },
};

const overviewTradesQuery = `
  query OverviewTradeKpis($limit: Int!, $offset: Int!) {
    trades(orderBy: createdAt_DESC, limit: $limit, offset: $offset) {
      tradeId
      status
    }
  }
`;

function aggregateTradeKpis(trades: TradeStatusRecord[]): OverviewTradeKpis {
  const byStatus = { locked: 0, stage_1: 0, stage_2: 0, completed: 0, disputed: 0 };
  for (const trade of trades) {
    switch (trade.status) {
      case 'LOCKED': byStatus.locked++; break;
      case 'IN_TRANSIT': byStatus.stage_1++; break;
      case 'ARRIVAL_CONFIRMED': byStatus.stage_2++; break;
      case 'CLOSED': byStatus.completed++; break;
      case 'FROZEN': byStatus.disputed++; break;
    }
  }
  return { total: trades.length, byStatus };
}

export class OverviewService implements OverviewReader {
  constructor(
    private readonly indexerGraphqlUrl: string,
    private readonly indexerRequestTimeoutMs: number,
    private readonly governanceStatusService: EscrowGovernanceReader,
    private readonly complianceStore: ComplianceStore,
  ) {}

  async getOverview(): Promise<OverviewSnapshot> {
    const now = new Date().toISOString();

    const [tradesResult, governanceResult, complianceResult] = await Promise.allSettled([
      this.fetchTradeKpis(),
      this.governanceStatusService.getGovernanceStatus(),
      this.complianceStore.countBlockedTrades(),
    ]);

    const tradesAvailable = tradesResult.status === 'fulfilled';
    const governanceAvailable = governanceResult.status === 'fulfilled';
    const complianceAvailable = complianceResult.status === 'fulfilled';

    const tradeKpis = tradesAvailable
      ? tradesResult.value
      : EMPTY_TRADE_KPIS;

    const posture: OverviewPosture | null = governanceAvailable
      ? {
          paused: governanceResult.value.paused,
          claimsPaused: governanceResult.value.claimsPaused,
          oracleActive: governanceResult.value.oracleActive,
        }
      : null;

    const blockedTrades = complianceAvailable ? complianceResult.value : 0;

    return {
      kpis: {
        trades: tradeKpis,
        compliance: { blockedTrades },
      },
      posture,
      feedFreshness: {
        trades: { source: 'indexer_graphql', queriedAt: tradesAvailable ? now : null, available: tradesAvailable },
        governance: { source: 'chain_rpc', queriedAt: governanceAvailable ? now : null, available: governanceAvailable },
        compliance: { source: 'gateway_ledger', queriedAt: complianceAvailable ? now : null, available: complianceAvailable },
      },
    };
  }

  private async fetchTradeKpis(): Promise<OverviewTradeKpis> {
    const aggregate: OverviewTradeKpis = {
      total: 0,
      byStatus: { locked: 0, stage_1: 0, stage_2: 0, completed: 0, disputed: 0 },
    };
    let offset = 0;

    while (true) {
      const trades = await this.fetchTradePage(OVERVIEW_TRADE_FETCH_LIMIT, offset);
      if (trades.length === 0) {
        break;
      }

      const pageKpis = aggregateTradeKpis(trades);
      aggregate.total += pageKpis.total;
      aggregate.byStatus.locked += pageKpis.byStatus.locked;
      aggregate.byStatus.stage_1 += pageKpis.byStatus.stage_1;
      aggregate.byStatus.stage_2 += pageKpis.byStatus.stage_2;
      aggregate.byStatus.completed += pageKpis.byStatus.completed;
      aggregate.byStatus.disputed += pageKpis.byStatus.disputed;

      if (trades.length < OVERVIEW_TRADE_FETCH_LIMIT) {
        break;
      }

      offset += trades.length;
    }

    return aggregate;
  }

  private async fetchTradePage(limit: number, offset: number): Promise<TradeStatusRecord[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.indexerRequestTimeoutMs);

    try {
      const response = await fetch(this.indexerGraphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: 'OverviewTradeKpis',
          query: overviewTradesQuery,
          variables: { limit, offset },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer request failed with HTTP ${response.status}`, {
          status: response.status,
        });
      }

      const payload = await response.json() as TradeStatusGraphQlResponse;
      if (payload.errors?.length) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned GraphQL errors', {
          errors: payload.errors.map((error) => error.message),
        });
      }

      const trades = payload.data?.trades;
      if (!Array.isArray(trades)) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned unexpected payload shape');
      }

      return trades;
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayError(504, 'UPSTREAM_UNAVAILABLE', 'Indexer request timed out', {
          timeoutMs: this.indexerRequestTimeoutMs,
        });
      }

      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer request failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
