"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReconciliationReadService = void 0;
function maxTimestamp(values) {
    let latestMs = Number.NEGATIVE_INFINITY;
    let latestValue = null;
    for (const value of values) {
        if (!value) {
            continue;
        }
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) {
            continue;
        }
        if (parsed > latestMs) {
            latestMs = parsed;
            latestValue = new Date(parsed).toISOString();
        }
    }
    return latestValue;
}
function mapReconciliationRecord(handoff, tradeProjection) {
    return {
        handoffId: handoff.handoffId,
        tradeId: handoff.tradeId,
        platformId: handoff.platformId,
        platformHandoffId: handoff.platformHandoffId,
        phase: handoff.phase,
        settlementChannel: handoff.settlementChannel,
        displayCurrency: handoff.displayCurrency,
        displayAmount: handoff.displayAmount,
        assetSymbol: handoff.assetSymbol,
        assetAmount: handoff.assetAmount,
        ricardianHash: handoff.ricardianHash,
        externalReference: handoff.externalReference,
        executionStatus: handoff.executionStatus,
        reconciliationStatus: handoff.reconciliationStatus,
        callbackStatus: handoff.callbackStatus,
        providerStatus: handoff.providerStatus,
        txHash: handoff.txHash,
        latestEventType: handoff.latestEventType,
        latestEventDetail: handoff.latestEventDetail,
        latestEventAt: handoff.latestEventAt,
        callbackDeliveredAt: handoff.callbackDeliveredAt,
        createdAt: handoff.createdAt,
        updatedAt: handoff.updatedAt,
        tradeProjection,
    };
}
function degradedReason(error) {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return 'Settlement ledger is unavailable';
}
function combineDegradedReasons(reasons) {
    const values = [...new Set(reasons.filter((reason) => Boolean(reason?.trim())).map((reason) => reason.trim()))];
    if (values.length === 0) {
        return undefined;
    }
    return values.join('; ');
}
class ReconciliationReadService {
    constructor(settlementStore, now = () => new Date()) {
        this.settlementStore = settlementStore;
        this.now = now;
    }
    async listReconciliation(query) {
        const queriedAt = this.now().toISOString();
        try {
            const handoffs = await this.settlementStore.listHandoffs(query);
            const projectionResult = await this.settlementStore.getTradeSettlementProjectionMap([...new Set(handoffs.items.map((item) => item.tradeId))]).then((value) => ({ ok: true, value })).catch((error) => ({
                ok: false,
                error: degradedReason(error),
            }));
            const items = handoffs.items.map((handoff) => mapReconciliationRecord(handoff, projectionResult.ok ? projectionResult.value.get(handoff.tradeId) ?? null : null));
            const responseDegradedReason = combineDegradedReasons([
                !projectionResult.ok ? projectionResult.error : undefined,
            ]);
            return {
                items,
                pagination: {
                    limit: query.limit,
                    offset: query.offset,
                    total: handoffs.total,
                },
                freshness: {
                    source: 'gateway_settlement_ledger',
                    sourceFreshAt: maxTimestamp([
                        handoffs.sourceFreshAt,
                        ...items.map((item) => item.tradeProjection?.updatedAt ?? null),
                    ]),
                    queriedAt,
                    available: responseDegradedReason ? false : true,
                    ...(responseDegradedReason ? { degradedReason: responseDegradedReason } : {}),
                },
            };
        }
        catch (error) {
            return {
                items: [],
                pagination: {
                    limit: query.limit,
                    offset: query.offset,
                    total: 0,
                },
                freshness: {
                    source: 'gateway_settlement_ledger',
                    sourceFreshAt: null,
                    queriedAt,
                    available: false,
                    degradedReason: degradedReason(error),
                },
            };
        }
    }
    async getReconciliationHandoff(handoffId) {
        const queriedAt = this.now().toISOString();
        try {
            const handoff = await this.settlementStore.getHandoff(handoffId);
            if (!handoff) {
                return {
                    handoff: null,
                    events: [],
                    freshness: {
                        source: 'gateway_settlement_ledger',
                        sourceFreshAt: null,
                        queriedAt,
                        available: true,
                    },
                };
            }
            const [eventsResult, projectionsResult] = await Promise.allSettled([
                this.settlementStore.listExecutionEvents(handoffId),
                this.settlementStore.getTradeSettlementProjectionMap([handoff.tradeId]),
            ]);
            const events = eventsResult.status === 'fulfilled' ? eventsResult.value : [];
            const tradeProjection = projectionsResult.status === 'fulfilled'
                ? projectionsResult.value.get(handoff.tradeId) ?? null
                : null;
            const responseDegradedReason = combineDegradedReasons([
                eventsResult.status === 'rejected' ? degradedReason(eventsResult.reason) : undefined,
                projectionsResult.status === 'rejected' ? degradedReason(projectionsResult.reason) : undefined,
            ]);
            return {
                handoff: mapReconciliationRecord(handoff, tradeProjection),
                events,
                freshness: {
                    source: 'gateway_settlement_ledger',
                    sourceFreshAt: maxTimestamp([
                        handoff.updatedAt,
                        tradeProjection?.updatedAt ?? null,
                        ...events.map((event) => event.observedAt),
                    ]),
                    queriedAt,
                    available: responseDegradedReason ? false : true,
                    ...(responseDegradedReason ? { degradedReason: responseDegradedReason } : {}),
                },
            };
        }
        catch (error) {
            return {
                handoff: null,
                events: [],
                freshness: {
                    source: 'gateway_settlement_ledger',
                    sourceFreshAt: null,
                    queriedAt,
                    available: false,
                    degradedReason: degradedReason(error),
                },
            };
        }
    }
}
exports.ReconciliationReadService = ReconciliationReadService;
//# sourceMappingURL=reconciliationReadService.js.map