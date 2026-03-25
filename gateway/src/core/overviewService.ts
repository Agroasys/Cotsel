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
    cancelled: number;
  };
}

export interface OverviewFeedStatus {
  source: string;
  queriedAt: string | null;
  freshAt: string | null;
  available: boolean;
}

export interface OverviewTradeFeedStatus extends OverviewFeedStatus {
  lastIndexedAt: string | null;
  lastProcessedBlock: string | null;
  lastTradeEventAt: string | null;
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
    trades: OverviewTradeFeedStatus;
    governance: OverviewFeedStatus;
    compliance: OverviewFeedStatus;
  };
}

export interface OverviewReader {
  getOverview(): Promise<OverviewSnapshot>;
}

interface IndexerOverviewSnapshot {
  totalTrades: number;
  lockedTrades: number;
  stage1Trades: number;
  stage2Trades: number;
  completedTrades: number;
  disputedTrades: number;
  cancelledTrades: number;
  lastProcessedBlock: string;
  lastIndexedAt: string;
  lastTradeEventAt: string | null;
}

interface OverviewSnapshotGraphQlResponse {
  data?: { overviewSnapshotById?: IndexerOverviewSnapshot | null };
  errors?: Array<{ message: string }>;
}

const EMPTY_TRADE_KPIS: OverviewTradeKpis = {
  total: 0,
  byStatus: { locked: 0, stage_1: 0, stage_2: 0, completed: 0, disputed: 0, cancelled: 0 },
};

const overviewSnapshotQuery = `
  query OverviewSnapshot {
    overviewSnapshotById(id: "singleton") {
      totalTrades
      lockedTrades
      stage1Trades
      stage2Trades
      completedTrades
      disputedTrades
      cancelledTrades
      lastProcessedBlock
      lastIndexedAt
      lastTradeEventAt
    }
  }
`;

function parseNonNegativeInteger(raw: number, field: string): number {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, {
      field,
      value: raw,
    });
  }

  return raw;
}

function parseIsoTimestamp(raw: string, field: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, {
      field,
      value: raw,
    });
  }

  return parsed.toISOString();
}

function parseOptionalIsoTimestamp(raw: string | null, field: string): string | null {
  if (raw === null) {
    return null;
  }

  return parseIsoTimestamp(raw, field);
}

function parseBlockNumber(raw: string, field: string): string {
  if (!/^\d+$/.test(raw)) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, {
      field,
      value: raw,
    });
  }

  return raw;
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

    const [snapshotResult, governanceResult, complianceResult] = await Promise.allSettled([
      this.fetchIndexerSnapshot(),
      this.governanceStatusService.getGovernanceStatus(),
      this.complianceStore.countBlockedTrades(),
    ]);

    const snapshotAvailable = snapshotResult.status === 'fulfilled';
    const governanceAvailable = governanceResult.status === 'fulfilled';
    const complianceAvailable = complianceResult.status === 'fulfilled';

    const indexerSnapshot = snapshotAvailable ? snapshotResult.value : null;

    const tradeKpis: OverviewTradeKpis = indexerSnapshot
      ? {
          total: indexerSnapshot.totalTrades,
          byStatus: {
            locked: indexerSnapshot.lockedTrades,
            stage_1: indexerSnapshot.stage1Trades,
            stage_2: indexerSnapshot.stage2Trades,
            completed: indexerSnapshot.completedTrades,
            disputed: indexerSnapshot.disputedTrades,
            cancelled: indexerSnapshot.cancelledTrades,
          },
        }
      : EMPTY_TRADE_KPIS;

    const posture: OverviewPosture | null = governanceAvailable
      ? {
          paused: governanceResult.value.paused,
          claimsPaused: governanceResult.value.claimsPaused,
          oracleActive: governanceResult.value.oracleActive,
        }
      : null;

    const blockedTrades = complianceAvailable ? complianceResult.value : 0;
    const tradesFeedFreshness: OverviewTradeFeedStatus = snapshotAvailable && indexerSnapshot
      ? {
          source: 'indexer_graphql',
          queriedAt: now,
          freshAt: indexerSnapshot.lastIndexedAt,
          available: true,
          lastIndexedAt: indexerSnapshot.lastIndexedAt,
          lastProcessedBlock: indexerSnapshot.lastProcessedBlock,
          lastTradeEventAt: indexerSnapshot.lastTradeEventAt,
        }
      : {
          source: 'indexer_graphql',
          queriedAt: null,
          freshAt: null,
          available: false,
          lastIndexedAt: null,
          lastProcessedBlock: null,
          lastTradeEventAt: null,
        };

    return {
      kpis: {
        trades: tradeKpis,
        compliance: { blockedTrades },
      },
      posture,
      feedFreshness: {
        trades: tradesFeedFreshness,
        governance: { source: 'chain_rpc', queriedAt: governanceAvailable ? now : null, freshAt: governanceAvailable ? now : null, available: governanceAvailable },
        compliance: { source: 'gateway_ledger', queriedAt: complianceAvailable ? now : null, freshAt: complianceAvailable ? now : null, available: complianceAvailable },
      },
    };
  }

  private async fetchIndexerSnapshot(): Promise<IndexerOverviewSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.indexerRequestTimeoutMs);

    try {
      const response = await fetch(this.indexerGraphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: 'OverviewSnapshot',
          query: overviewSnapshotQuery,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer request failed with HTTP ${response.status}`, {
          status: response.status,
        });
      }

      const payload = await response.json() as OverviewSnapshotGraphQlResponse;
      if (payload.errors?.length) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned GraphQL errors', {
          errors: payload.errors.map((error) => error.message),
        });
      }

      const snapshot = payload.data?.overviewSnapshotById;
      if (!snapshot) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned no overview snapshot');
      }

      return {
        totalTrades: parseNonNegativeInteger(snapshot.totalTrades, 'overviewSnapshot.totalTrades'),
        lockedTrades: parseNonNegativeInteger(snapshot.lockedTrades, 'overviewSnapshot.lockedTrades'),
        stage1Trades: parseNonNegativeInteger(snapshot.stage1Trades, 'overviewSnapshot.stage1Trades'),
        stage2Trades: parseNonNegativeInteger(snapshot.stage2Trades, 'overviewSnapshot.stage2Trades'),
        completedTrades: parseNonNegativeInteger(snapshot.completedTrades, 'overviewSnapshot.completedTrades'),
        disputedTrades: parseNonNegativeInteger(snapshot.disputedTrades, 'overviewSnapshot.disputedTrades'),
        cancelledTrades: parseNonNegativeInteger(snapshot.cancelledTrades, 'overviewSnapshot.cancelledTrades'),
        lastProcessedBlock: parseBlockNumber(snapshot.lastProcessedBlock, 'overviewSnapshot.lastProcessedBlock'),
        lastIndexedAt: parseIsoTimestamp(snapshot.lastIndexedAt, 'overviewSnapshot.lastIndexedAt'),
        lastTradeEventAt: parseOptionalIsoTimestamp(snapshot.lastTradeEventAt, 'overviewSnapshot.lastTradeEventAt'),
      };
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
