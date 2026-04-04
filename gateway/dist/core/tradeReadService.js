"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeReadService = void 0;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const ethers_1 = require("ethers");
const indexerGraphqlClient_1 = require("./indexerGraphqlClient");
const errors_1 = require("../errors");
const transactionReference_1 = require("./transactionReference");
function assertIsoTimestamp(value, field) {
    if (Number.isNaN(Date.parse(value))) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} timestamp`, {
            field,
            value,
        });
    }
    return new Date(value).toISOString();
}
function assertUnixSecondsTimestamp(value, field) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} timestamp`, {
            field,
            value,
        });
    }
    const timestamp = new Date(seconds * 1000);
    if (Number.isNaN(timestamp.getTime())) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} timestamp`, {
            field,
            value,
        });
    }
    return timestamp.toISOString();
}
function parseHash(txHash) {
    const candidate = txHash ?? undefined;
    return candidate && candidate.trim().length > 0 ? candidate : undefined;
}
function asUsdcNumber(raw, field) {
    try {
        const formatted = (0, ethers_1.formatUnits)(BigInt(raw), 6);
        const value = Number(formatted);
        if (!Number.isFinite(value)) {
            throw new Error('Formatted value is not finite');
        }
        return value;
    }
    catch (error) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer returned invalid ${field} amount`, {
            field,
            raw,
            reason: error instanceof Error ? error.message : String(error),
        });
    }
}
function mapTradeStatus(status) {
    switch (status) {
        case 'LOCKED':
            return 'locked';
        case 'IN_TRANSIT':
            return 'stage_1';
        case 'ARRIVAL_CONFIRMED':
            return 'stage_2';
        case 'FROZEN':
            return 'disputed';
        case 'CLOSED':
            return 'completed';
        default:
            throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned unknown trade status', { status });
    }
}
function mapComplianceStatus(result) {
    if (result === 'ALLOW') {
        return 'pass';
    }
    if (result === 'DENY') {
        return 'fail';
    }
    return 'unavailable';
}
function mapEventStage(eventName) {
    switch (eventName) {
        case 'TradeLocked':
            return 'Lock';
        case 'FundsReleasedStage1':
            return 'Stage 1 Release';
        case 'PlatformFeesPaidStage1':
            return 'Platform Fee Settlement';
        case 'ArrivalConfirmed':
            return 'Arrival Confirmed';
        case 'FinalTrancheReleased':
            return 'Final Settlement';
        case 'DisputeOpenedByBuyer':
            return 'Dispute Opened';
        case 'TradeCancelledAfterLockTimeout':
            return 'Lock Timeout Refund';
        case 'InTransitTimeoutRefunded':
            return 'Transit Timeout Refund';
        case 'DisputePayout':
            return 'Dispute Payout';
        case 'ClaimableAccrued':
            return 'Claim Accrued';
        default:
            return eventName;
    }
}
function mapEventActor(eventName) {
    switch (eventName) {
        case 'TradeLocked':
        case 'DisputeOpenedByBuyer':
        case 'TradeCancelledAfterLockTimeout':
        case 'InTransitTimeoutRefunded':
            return 'Buyer';
        case 'FundsReleasedStage1':
        case 'ArrivalConfirmed':
        case 'FinalTrancheReleased':
            return 'Oracle';
        case 'PlatformFeesPaidStage1':
        case 'ClaimableAccrued':
            return 'Treasury';
        case 'DisputePayout':
            return 'Governance';
        default:
            return 'Protocol';
    }
}
function mapEventDetail(event) {
    switch (event.eventName) {
        case 'TradeLocked':
            return event.totalAmount ? `Escrow locked for ${asUsdcNumber(event.totalAmount, 'event.totalAmount').toLocaleString()} USDC.` : undefined;
        case 'FundsReleasedStage1':
            return `Stage 1 released ${asUsdcNumber(event.releasedFirstTranche ?? '0', 'event.releasedFirstTranche').toLocaleString()} USDC plus ${asUsdcNumber(event.releasedLogisticsAmount ?? '0', 'event.releasedLogisticsAmount').toLocaleString()} USDC logistics.`;
        case 'PlatformFeesPaidStage1':
            return `Platform fees settled: ${asUsdcNumber(event.paidPlatformFees ?? '0', 'event.paidPlatformFees').toLocaleString()} USDC.`;
        case 'ArrivalConfirmed':
            return event.arrivalTimestamp
                ? `Arrival confirmed at ${assertUnixSecondsTimestamp(event.arrivalTimestamp, 'event.arrivalTimestamp')}.`
                : 'Arrival milestone confirmed by oracle.';
        case 'FinalTrancheReleased':
            return `Final tranche released to ${event.finalRecipient ?? 'supplier'} for ${asUsdcNumber(event.finalTranche ?? '0', 'event.finalTranche').toLocaleString()} USDC.`;
        case 'DisputeOpenedByBuyer':
            return 'Buyer opened a dispute within the post-arrival review window.';
        case 'TradeCancelledAfterLockTimeout':
            return `Trade cancelled after lock timeout. Refunded ${asUsdcNumber(event.refundedAmount ?? '0', 'event.refundedAmount').toLocaleString()} USDC to ${event.refundedTo ?? 'buyer'}.`;
        case 'InTransitTimeoutRefunded':
            return `In-transit timeout refund executed for ${asUsdcNumber(event.refundedBuyerPrincipal ?? '0', 'event.refundedBuyerPrincipal').toLocaleString()} USDC.`;
        case 'DisputePayout':
            return `Governance resolved dispute with ${event.payoutType ?? 'unknown'} payout of ${asUsdcNumber(event.payoutAmount ?? '0', 'event.payoutAmount').toLocaleString()} USDC to ${event.payoutRecipient ?? 'recipient'}.`;
        case 'ClaimableAccrued':
            return `Claim accrued: ${event.claimType ?? 'unknown'} for ${event.claimRecipient ?? 'recipient'} (${asUsdcNumber(event.claimAmount ?? '0', 'event.claimAmount').toLocaleString()} USDC).`;
        default:
            return undefined;
    }
}
function mapTimeline(events, explorerBaseUrl) {
    const sorted = [...(events ?? [])].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
    return sorted.map((event) => {
        const reference = (0, transactionReference_1.buildSettlementTransactionReference)(event.txHash, explorerBaseUrl);
        const eventHash = parseHash(reference.txHash);
        const eventDetail = mapEventDetail(event);
        return {
            stage: mapEventStage(event.eventName),
            timestamp: assertIsoTimestamp(event.timestamp, 'tradeEvent.timestamp'),
            actor: mapEventActor(event.eventName),
            ...(eventHash ? { txHash: eventHash } : {}),
            ...(reference.explorerUrl ? { explorerUrl: reference.explorerUrl } : {}),
            ...(eventDetail ? { detail: eventDetail } : {}),
        };
    });
}
function parseGraphQlResponse(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned an invalid GraphQL payload');
    }
    return payload;
}
function readTradesArray(payload) {
    if (!payload.data || typeof payload.data !== 'object' || !('trades' in payload.data) || !Array.isArray(payload.data.trades)) {
        throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned an invalid GraphQL payload');
    }
    return payload.data.trades;
}
const listTradesQuery = `
  query DashboardTrades($limit: Int!, $offset: Int!) {
    trades(orderBy: createdAt_DESC, limit: $limit, offset: $offset) {
      tradeId
      buyer
      supplier
      status
      totalAmountLocked
      logisticsAmount
      platformFeesAmount
      ricardianHash
      createdAt
      arrivalTimestamp
      events(orderBy: timestamp_ASC) {
        eventName
        timestamp
        txHash
        totalAmount
        releasedFirstTranche
        releasedLogisticsAmount
        paidPlatformFees
        arrivalTimestamp
        finalTranche
        finalRecipient
        refundedAmount
        refundedTo
        refundedBuyerPrincipal
        claimType
        claimRecipient
        claimAmount
        payoutRecipient
        payoutAmount
        payoutType
      }
    }
  }
`;
const tradeDetailQuery = `
  query DashboardTradeDetail($tradeId: String!) {
    trades(where: { tradeId_eq: $tradeId }, limit: 1) {
      tradeId
      buyer
      supplier
      status
      totalAmountLocked
      logisticsAmount
      platformFeesAmount
      ricardianHash
      createdAt
      arrivalTimestamp
      events(orderBy: timestamp_ASC) {
        eventName
        timestamp
        txHash
        totalAmount
        releasedFirstTranche
        releasedLogisticsAmount
        paidPlatformFees
        arrivalTimestamp
        finalTranche
        finalRecipient
        refundedAmount
        refundedTo
        refundedBuyerPrincipal
        claimType
        claimRecipient
        claimAmount
        payoutRecipient
        payoutAmount
        payoutType
      }
    }
  }
`;
class TradeReadService {
    constructor(indexerClientOrUrl, indexerRequestTimeoutOrComplianceStore, complianceStoreOrSettlementStore, maybeSettlementReadStoreOrExplorerBaseUrl, maybeExplorerBaseUrl) {
        if (typeof indexerClientOrUrl === 'string') {
            this.indexerClient = new indexerGraphqlClient_1.IndexerGraphqlClient(indexerClientOrUrl, indexerRequestTimeoutOrComplianceStore);
            this.complianceStore = complianceStoreOrSettlementStore;
            this.settlementReadStore = typeof maybeSettlementReadStoreOrExplorerBaseUrl === 'string'
                ? undefined
                : maybeSettlementReadStoreOrExplorerBaseUrl ?? undefined;
            this.explorerBaseUrl = typeof maybeSettlementReadStoreOrExplorerBaseUrl === 'string'
                ? maybeSettlementReadStoreOrExplorerBaseUrl
                : maybeExplorerBaseUrl;
            return;
        }
        this.indexerClient = indexerClientOrUrl;
        this.complianceStore = indexerRequestTimeoutOrComplianceStore;
        this.settlementReadStore = complianceStoreOrSettlementStore;
        this.explorerBaseUrl = typeof maybeSettlementReadStoreOrExplorerBaseUrl === 'string'
            ? maybeSettlementReadStoreOrExplorerBaseUrl
            : maybeExplorerBaseUrl;
    }
    async checkReadiness() {
        const response = await this.executeQuery('DashboardGatewayTradeReadiness', 'query DashboardGatewayTradeReadiness { trades(limit: 1) { tradeId } }');
        readTradesArray(response);
    }
    async listTrades(limit = 100, offset = 0) {
        const response = await this.executeQuery('DashboardTrades', listTradesQuery, { limit, offset });
        const trades = readTradesArray(response);
        const settlementProjectionMap = this.settlementReadStore
            ? await this.settlementReadStore.getTradeSettlementProjectionMap(trades.map((trade) => trade.tradeId))
            : new Map();
        return Promise.all(trades.map((trade) => this.mapTradeRecord(trade, settlementProjectionMap.get(trade.tradeId) ?? null)));
    }
    async getTrade(tradeId) {
        const response = await this.executeQuery('DashboardTradeDetail', tradeDetailQuery, { tradeId });
        const trade = readTradesArray(response)[0];
        if (!trade) {
            return null;
        }
        const settlementProjectionMap = this.settlementReadStore
            ? await this.settlementReadStore.getTradeSettlementProjectionMap([trade.tradeId])
            : new Map();
        return this.mapTradeRecord(trade, settlementProjectionMap.get(trade.tradeId) ?? null);
    }
    async mapTradeRecord(trade, settlementProjection) {
        const timeline = mapTimeline(trade.events, this.explorerBaseUrl);
        const lockReference = timeline.find((event) => event.stage === 'Lock' && event.txHash)?.txHash
            ?? timeline.find((event) => event.txHash)?.txHash
            ?? null;
        const compliance = await this.complianceStore.getTradeStatus(trade.tradeId);
        const latestTimelineEntry = timeline.length > 0 ? timeline[timeline.length - 1] : null;
        const updatedAt = latestTimelineEntry?.timestamp ?? assertIsoTimestamp(trade.createdAt, 'trade.createdAt');
        const settlementReference = (0, transactionReference_1.buildSettlementTransactionReference)(settlementProjection?.txHash ?? null, this.explorerBaseUrl);
        return {
            id: trade.tradeId,
            buyer: trade.buyer,
            supplier: trade.supplier,
            amount: asUsdcNumber(trade.totalAmountLocked, 'trade.totalAmountLocked'),
            currency: 'USDC',
            status: mapTradeStatus(trade.status),
            txHash: lockReference,
            createdAt: assertIsoTimestamp(trade.createdAt, 'trade.createdAt'),
            updatedAt,
            ricardianHash: trade.ricardianHash,
            platformFee: asUsdcNumber(trade.platformFeesAmount, 'trade.platformFeesAmount'),
            logisticsAmount: asUsdcNumber(trade.logisticsAmount, 'trade.logisticsAmount'),
            timeline,
            complianceStatus: mapComplianceStatus(compliance?.currentResult ?? null),
            settlement: settlementProjection ? {
                handoffId: settlementProjection.handoffId,
                platformId: settlementProjection.platformId,
                platformHandoffId: settlementProjection.platformHandoffId,
                phase: settlementProjection.phase,
                settlementChannel: settlementProjection.settlementChannel,
                displayCurrency: settlementProjection.displayCurrency,
                displayAmount: settlementProjection.displayAmount,
                executionStatus: settlementProjection.executionStatus,
                reconciliationStatus: settlementProjection.reconciliationStatus,
                callbackStatus: settlementProjection.callbackStatus,
                providerStatus: settlementProjection.providerStatus,
                txHash: settlementReference.txHash,
                ...(settlementReference.explorerUrl ? { explorerUrl: settlementReference.explorerUrl } : {}),
                externalReference: settlementProjection.externalReference,
                latestEventType: settlementProjection.latestEventType,
                latestEventDetail: settlementProjection.latestEventDetail,
                latestEventAt: settlementProjection.latestEventAt,
                callbackDeliveredAt: settlementProjection.callbackDeliveredAt,
                createdAt: settlementProjection.createdAt,
                updatedAt: settlementProjection.updatedAt,
            } : null,
        };
    }
    async executeQuery(operationName, query, variables) {
        return parseGraphQlResponse(await this.indexerClient.query(operationName, query, variables));
    }
}
exports.TradeReadService = TradeReadService;
//# sourceMappingURL=tradeReadService.js.map