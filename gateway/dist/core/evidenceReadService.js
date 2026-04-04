"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvidenceReadService = void 0;
const errors_1 = require("../errors");
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
function degradedReason(error, fallback) {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return fallback;
}
function combineDegradedReasons(reasons) {
    const values = [...new Set(reasons.filter((reason) => Boolean(reason?.trim())).map((reason) => reason.trim()))];
    if (values.length === 0) {
        return undefined;
    }
    return values.join('; ');
}
async function readAllComplianceDecisions(complianceStore, tradeId) {
    const items = [];
    let cursor;
    do {
        const page = await complianceStore.listTradeDecisions({ tradeId, limit: 100, cursor });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
}
async function readAllGovernanceActions(governanceActionStore, tradeId) {
    const items = [];
    let cursor;
    do {
        const page = await governanceActionStore.list({ tradeId, limit: 100, cursor });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
}
class EvidenceReadService {
    constructor(tradeReadService, settlementStore, ricardianClient, complianceStore, governanceActionStore, now = () => new Date()) {
        this.tradeReadService = tradeReadService;
        this.settlementStore = settlementStore;
        this.ricardianClient = ricardianClient;
        this.complianceStore = complianceStore;
        this.governanceActionStore = governanceActionStore;
        this.now = now;
    }
    async getRicardianDocument(tradeId) {
        const trade = await this.tradeReadService.getTrade(tradeId);
        if (!trade) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Trade not found', { tradeId });
        }
        if (!trade.ricardianHash) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Trade has no Ricardian hash', {
                tradeId,
                reason: 'missing_ricardian_hash',
            });
        }
        const queriedAt = this.now().toISOString();
        let settlementHashMatchesTrade = null;
        let settlementLookupDegradedReason;
        if (trade.settlement) {
            try {
                const settlementHandoff = await this.settlementStore.getHandoff(trade.settlement.handoffId);
                settlementHashMatchesTrade = settlementHandoff?.ricardianHash
                    ? settlementHandoff.ricardianHash.toLowerCase() === trade.ricardianHash.toLowerCase()
                    : null;
            }
            catch (error) {
                settlementLookupDegradedReason = degradedReason(error, 'Settlement handoff lookup is unavailable');
            }
        }
        try {
            const document = await this.ricardianClient.getDocument(trade.ricardianHash);
            const tradeHashMatchesDocument = document.hash.toLowerCase() === trade.ricardianHash.toLowerCase();
            const responseDegradedReason = combineDegradedReasons([settlementLookupDegradedReason]);
            const verificationStatus = responseDegradedReason
                ? 'unavailable'
                : tradeHashMatchesDocument && settlementHashMatchesTrade !== false
                    ? 'verified'
                    : 'mismatch';
            return {
                tradeId,
                ricardianHash: trade.ricardianHash,
                document,
                verification: {
                    status: verificationStatus,
                    tradeHashMatchesDocument,
                    settlementHashMatchesTrade,
                },
                freshness: {
                    source: 'ricardian_http',
                    sourceFreshAt: document.createdAt,
                    queriedAt,
                    available: responseDegradedReason ? false : true,
                    ...(responseDegradedReason ? { degradedReason: responseDegradedReason } : {}),
                },
            };
        }
        catch (error) {
            if (error instanceof errors_1.GatewayError && error.statusCode === 404) {
                throw error;
            }
            return {
                tradeId,
                ricardianHash: trade.ricardianHash,
                document: null,
                verification: {
                    status: 'unavailable',
                    tradeHashMatchesDocument: null,
                    settlementHashMatchesTrade,
                },
                freshness: {
                    source: 'ricardian_http',
                    sourceFreshAt: null,
                    queriedAt,
                    available: false,
                    degradedReason: degradedReason(error, 'Ricardian service is unavailable'),
                },
            };
        }
    }
    async getTradeEvidence(tradeId) {
        const trade = await this.tradeReadService.getTrade(tradeId);
        if (!trade) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Trade not found', { tradeId });
        }
        const queriedAt = this.now().toISOString();
        const [complianceResult, governanceResult] = await Promise.allSettled([
            readAllComplianceDecisions(this.complianceStore, tradeId),
            readAllGovernanceActions(this.governanceActionStore, tradeId),
        ]);
        const complianceDecisions = complianceResult.status === 'fulfilled' ? complianceResult.value : [];
        const governanceActions = governanceResult.status === 'fulfilled' ? governanceResult.value : [];
        const responseDegradedReason = combineDegradedReasons([
            complianceResult.status === 'rejected'
                ? degradedReason(complianceResult.reason, 'Compliance evidence source is unavailable')
                : undefined,
            governanceResult.status === 'rejected'
                ? degradedReason(governanceResult.reason, 'Governance evidence source is unavailable')
                : undefined,
        ]);
        return {
            tradeId,
            ricardianHash: trade.ricardianHash,
            settlement: trade.settlement,
            complianceDecisions,
            governanceActions,
            freshness: {
                source: 'gateway_ledgers',
                sourceFreshAt: maxTimestamp([
                    trade.settlement?.updatedAt ?? null,
                    ...complianceDecisions.map((decision) => decision.decidedAt),
                    ...governanceActions.flatMap((action) => [action.executedAt, action.createdAt]),
                ]),
                queriedAt,
                available: responseDegradedReason ? false : true,
                ...(responseDegradedReason ? { degradedReason: responseDegradedReason } : {}),
            },
        };
    }
}
exports.EvidenceReadService = EvidenceReadService;
//# sourceMappingURL=evidenceReadService.js.map