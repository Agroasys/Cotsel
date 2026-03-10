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
  source: 'indexer' | 'governance' | 'compliance';
  freshAt: string | null;
  queriedAt: string | null;
  available: boolean;
}

export interface OverviewSourceError {
  source: 'indexer' | 'governance' | 'compliance';
  code: 'UPSTREAM_UNAVAILABLE';
  message: string;
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
  errors: OverviewSourceError[];
}

export interface OverviewReader {
  getOverview(): Promise<OverviewSnapshot>;
}

interface OverviewSnapshotRecord {
  totalTrades: string | number;
  lockedTrades: string | number;
  stage1Trades: string | number;
  stage2Trades: string | number;
  completedTrades: string | number;
  disputedTrades: string | number;
  cancelledTrades: string | number;
  lastProcessedBlock: string;
  lastIndexedAt: string;
  lastTradeEventAt?: string | null;
}

interface OverviewGraphQlResponse {
  data?: { overviewSnapshots?: OverviewSnapshotRecord[] };
  errors?: Array<{ message: string }>;
}

const OVERVIEW_SNAPSHOT_QUERY = `
  query GatewayOverviewSnapshot($snapshotId: String!) {
    overviewSnapshots(where: { id_eq: $snapshotId }, limit: 1) {
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

const EMPTY_TRADE_KPIS: OverviewTradeKpis = {
  total: 0,
  byStatus: { locked: 0, stage_1: 0, stage_2: 0, completed: 0, disputed: 0 },
};

function asNonNegativeInteger(value: string | number, field: string): number {
  const numeric = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, { field, value });
  }

  return numeric;
}

function asIsoTimestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, { field, value });
  }

  return parsed.toISOString();
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof GatewayError) {
    return error.message;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function mapTradeKpis(snapshot: OverviewSnapshotRecord): OverviewTradeKpis {
  return {
    total: asNonNegativeInteger(snapshot.totalTrades, 'overviewSnapshot.totalTrades'),
    byStatus: {
      locked: asNonNegativeInteger(snapshot.lockedTrades, 'overviewSnapshot.lockedTrades'),
      stage_1: asNonNegativeInteger(snapshot.stage1Trades, 'overviewSnapshot.stage1Trades'),
      stage_2: asNonNegativeInteger(snapshot.stage2Trades, 'overviewSnapshot.stage2Trades'),
      completed: asNonNegativeInteger(snapshot.completedTrades, 'overviewSnapshot.completedTrades'),
      disputed: asNonNegativeInteger(snapshot.disputedTrades, 'overviewSnapshot.disputedTrades'),
    },
  };
}

export class OverviewService implements OverviewReader {
  constructor(
    private readonly indexerGraphqlUrl: string,
    private readonly indexerRequestTimeoutMs: number,
    private readonly governanceStatusService: EscrowGovernanceReader,
    private readonly complianceStore: ComplianceStore,
  ) {}

  async getOverview(): Promise<OverviewSnapshot> {
    const [tradesResult, governanceResult, complianceResult] = await Promise.allSettled([
      this.fetchOverviewSnapshot(),
      this.governanceStatusService.getGovernanceStatus(),
      this.complianceStore.getOverviewMetrics(),
    ]);

    const errors: OverviewSourceError[] = [];

    const tradesAvailable = tradesResult.status === 'fulfilled';
    const governanceAvailable = governanceResult.status === 'fulfilled';
    const complianceAvailable = complianceResult.status === 'fulfilled';

    if (!tradesAvailable) {
      errors.push({
        source: 'indexer',
        code: 'UPSTREAM_UNAVAILABLE',
        message: safeErrorMessage(tradesResult.reason, 'Indexer overview snapshot unavailable'),
      });
    }

    if (!governanceAvailable) {
      errors.push({
        source: 'governance',
        code: 'UPSTREAM_UNAVAILABLE',
        message: safeErrorMessage(governanceResult.reason, 'Governance source unavailable'),
      });
    }

    if (!complianceAvailable) {
      errors.push({
        source: 'compliance',
        code: 'UPSTREAM_UNAVAILABLE',
        message: safeErrorMessage(complianceResult.reason, 'Compliance source unavailable'),
      });
    }

    return {
      kpis: {
        trades: tradesAvailable ? tradesResult.value.kpis : EMPTY_TRADE_KPIS,
        compliance: {
          blockedTrades: complianceAvailable ? complianceResult.value.blockedTrades : 0,
        },
      },
      posture: governanceAvailable
        ? {
            paused: governanceResult.value.paused,
            claimsPaused: governanceResult.value.claimsPaused,
            oracleActive: governanceResult.value.oracleActive,
          }
        : null,
      feedFreshness: {
        trades: tradesAvailable
          ? {
              source: 'indexer',
              freshAt: tradesResult.value.freshAt,
              queriedAt: tradesResult.value.queriedAt,
              available: true,
            }
          : {
              source: 'indexer',
              freshAt: null,
              queriedAt: null,
              available: false,
            },
        governance: governanceAvailable
          ? {
              source: 'governance',
              freshAt: governanceResult.value.chainBlockTimestamp,
              queriedAt: governanceResult.value.queriedAt,
              available: true,
            }
          : {
              source: 'governance',
              freshAt: null,
              queriedAt: null,
              available: false,
            },
        compliance: complianceAvailable
          ? {
              source: 'compliance',
              freshAt: complianceResult.value.freshAt,
              queriedAt: new Date().toISOString(),
              available: true,
            }
          : {
              source: 'compliance',
              freshAt: null,
              queriedAt: null,
              available: false,
            },
      },
      errors,
    };
  }

  private async fetchOverviewSnapshot(): Promise<{ kpis: OverviewTradeKpis; freshAt: string; queriedAt: string }> {
    const queriedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.indexerRequestTimeoutMs);

    try {
      const response = await fetch(this.indexerGraphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: 'GatewayOverviewSnapshot',
          query: OVERVIEW_SNAPSHOT_QUERY,
          variables: { snapshotId: 'singleton' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer request failed with HTTP ${response.status}`, {
          status: response.status,
        });
      }

      const payload = await response.json() as OverviewGraphQlResponse;
      if (payload.errors?.length) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned GraphQL errors', {
          errors: payload.errors.map((error) => error.message),
        });
      }

      const snapshot = payload.data?.overviewSnapshots?.[0];
      if (!snapshot) {
        throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Indexer overview snapshot is missing');
      }

      return {
        kpis: mapTradeKpis(snapshot),
        freshAt: asIsoTimestamp(snapshot.lastIndexedAt, 'overviewSnapshot.lastIndexedAt'),
        queriedAt,
      };
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayError(504, 'UPSTREAM_UNAVAILABLE', 'Indexer overview request timed out', {
          timeoutMs: this.indexerRequestTimeoutMs,
        });
      }

      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer overview request failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
