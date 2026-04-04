"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OverviewService = void 0;
const indexerGraphqlClient_1 = require("./indexerGraphqlClient");
const errors_1 = require("../errors");
const EMPTY_TRADE_KPIS = {
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
function parseNonNegativeInteger(raw, field) {
    if (!Number.isSafeInteger(raw) || raw < 0) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, {
            field,
            value: raw,
        });
    }
    return raw;
}
function parseIsoTimestamp(raw, field) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, {
            field,
            value: raw,
        });
    }
    return parsed.toISOString();
}
function parseOptionalIsoTimestamp(raw, field) {
    if (raw === null) {
        return null;
    }
    return parseIsoTimestamp(raw, field);
}
function parseBlockNumber(raw, field) {
    if (!/^\d+$/.test(raw)) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field}`, {
            field,
            value: raw,
        });
    }
    return raw;
}
class OverviewService {
    constructor(indexerClientOrUrl, indexerRequestTimeoutOrGovernanceStatusService, governanceStatusServiceOrComplianceStore, maybeComplianceStore) {
        if (typeof indexerClientOrUrl === 'string') {
            this.indexerClient = new indexerGraphqlClient_1.IndexerGraphqlClient(indexerClientOrUrl, indexerRequestTimeoutOrGovernanceStatusService);
            this.governanceStatusService = governanceStatusServiceOrComplianceStore;
            this.complianceStore = maybeComplianceStore;
            return;
        }
        this.indexerClient = indexerClientOrUrl;
        this.governanceStatusService = indexerRequestTimeoutOrGovernanceStatusService;
        this.complianceStore = governanceStatusServiceOrComplianceStore;
    }
    async getOverview() {
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
        const tradeKpis = indexerSnapshot
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
        const posture = governanceAvailable
            ? {
                paused: governanceResult.value.paused,
                claimsPaused: governanceResult.value.claimsPaused,
                oracleActive: governanceResult.value.oracleActive,
            }
            : null;
        const blockedTrades = complianceAvailable ? complianceResult.value : 0;
        const tradesFeedFreshness = snapshotAvailable && indexerSnapshot
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
    async fetchIndexerSnapshot() {
        const payload = await this.indexerClient.query('OverviewSnapshot', overviewSnapshotQuery);
        const snapshot = payload.data?.overviewSnapshotById;
        if (!snapshot) {
            throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned no overview snapshot');
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
    }
}
exports.OverviewService = OverviewService;
//# sourceMappingURL=overviewService.js.map