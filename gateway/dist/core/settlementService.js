"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettlementService = void 0;
const errors_1 = require("../errors");
const settlementStateMachine_1 = require("./settlementStateMachine");
function parseIsoTimestamp(value, field) {
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be an ISO-8601 timestamp`, { field, value });
    }
    return timestamp.toISOString();
}
function requireNonEmpty(value, field) {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} is required`);
    }
    return trimmed;
}
function validateAmount(value, field) {
    if (!Number.isFinite(value) || value < 0) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be a non-negative number`, { field, value });
    }
    return value;
}
class SettlementService {
    constructor(config, store) {
        this.config = config;
        this.store = store;
    }
    async createHandoff(input) {
        return this.store.createHandoff({
            ...input,
            platformId: requireNonEmpty(input.platformId, 'platformId'),
            platformHandoffId: requireNonEmpty(input.platformHandoffId, 'platformHandoffId'),
            tradeId: requireNonEmpty(input.tradeId, 'tradeId'),
            phase: requireNonEmpty(input.phase, 'phase'),
            settlementChannel: requireNonEmpty(input.settlementChannel, 'settlementChannel'),
            displayCurrency: requireNonEmpty(input.displayCurrency, 'displayCurrency'),
            displayAmount: validateAmount(input.displayAmount, 'displayAmount'),
            assetAmount: input.assetAmount === undefined || input.assetAmount === null
                ? null
                : validateAmount(input.assetAmount, 'assetAmount'),
            ricardianHash: input.ricardianHash?.trim() || null,
            externalReference: input.externalReference?.trim() || null,
            metadata: input.metadata ?? {},
        });
    }
    async recordExecutionEvent(input) {
        const handoff = await this.store.getHandoff(input.handoffId);
        if (!handoff) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', { handoffId: input.handoffId });
        }
        (0, settlementStateMachine_1.validateExecutionTransition)(handoff.executionStatus, input.executionStatus, input.eventType);
        const observedAt = parseIsoTimestamp(input.observedAt, 'observedAt');
        const event = await this.store.createExecutionEvent({
            ...input,
            observedAt,
        });
        const updatedHandoff = await this.store.getHandoff(input.handoffId);
        if (!updatedHandoff) {
            throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Settlement handoff disappeared after event persistence', {
                handoffId: input.handoffId,
            });
        }
        let callbackDelivery = null;
        if (this.shouldQueueCallback()) {
            callbackDelivery = await this.store.queueCallbackDelivery({
                handoffId: updatedHandoff.handoffId,
                eventId: event.eventId,
                targetUrl: this.config.settlementCallbackUrl,
                requestBody: this.buildCallbackPayload(updatedHandoff, event),
                requestId: input.requestId,
                status: 'pending',
                nextAttemptAt: new Date().toISOString(),
            });
        }
        else {
            callbackDelivery = await this.store.queueCallbackDelivery({
                handoffId: updatedHandoff.handoffId,
                eventId: event.eventId,
                targetUrl: this.config.settlementCallbackUrl ?? 'disabled://callback',
                requestBody: this.buildCallbackPayload(updatedHandoff, event),
                requestId: input.requestId,
                status: 'disabled',
                nextAttemptAt: new Date().toISOString(),
            });
        }
        return {
            handoff: updatedHandoff,
            event,
            callbackDelivery,
        };
    }
    async listExecutionEvents(handoffId) {
        return this.store.listExecutionEvents(requireNonEmpty(handoffId, 'handoffId'));
    }
    buildCallbackPayload(handoff, event) {
        return {
            eventId: event.eventId,
            handoffId: handoff.handoffId,
            platformId: handoff.platformId,
            platformHandoffId: handoff.platformHandoffId,
            tradeId: handoff.tradeId,
            phase: handoff.phase,
            settlementChannel: handoff.settlementChannel,
            displayCurrency: handoff.displayCurrency,
            displayAmount: handoff.displayAmount,
            executionStatus: handoff.executionStatus,
            reconciliationStatus: handoff.reconciliationStatus,
            callbackStatus: handoff.callbackStatus,
            providerStatus: handoff.providerStatus,
            txHash: handoff.txHash,
            latestEventType: handoff.latestEventType,
            latestEventDetail: handoff.latestEventDetail,
            latestEventAt: handoff.latestEventAt,
            observedAt: event.observedAt,
            metadata: {
                ...handoff.metadata,
                event: event.metadata,
            },
        };
    }
    shouldQueueCallback() {
        return this.config.settlementCallbackEnabled
            && Boolean(this.config.settlementCallbackUrl)
            && Boolean(this.config.settlementCallbackApiKey)
            && Boolean(this.config.settlementCallbackApiSecret);
    }
}
exports.SettlementService = SettlementService;
//# sourceMappingURL=settlementService.js.map