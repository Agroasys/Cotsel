"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettlementCallbackDispatcher = void 0;
const logger_1 = require("../logging/logger");
const serviceAuth_1 = require("./serviceAuth");
function computeBackoffMs(attemptCount, initialBackoffMs, maxBackoffMs) {
    const backoff = initialBackoffMs * (2 ** Math.max(0, attemptCount - 1));
    return Math.min(maxBackoffMs, backoff);
}
class SettlementCallbackDispatcher {
    constructor(config, store, options = {}) {
        this.config = config;
        this.store = store;
        this.timer = null;
        this.running = false;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? (() => new Date());
        this.failedOperationWorkflow = options.failedOperationWorkflow;
    }
    start() {
        if (!this.config.settlementCallbackEnabled || this.timer) {
            return;
        }
        this.timer = setInterval(() => {
            void this.processDueDeliveries();
        }, this.config.settlementCallbackPollIntervalMs);
        void this.processDueDeliveries();
    }
    stop() {
        if (!this.timer) {
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
    }
    async processDueDeliveries(limit = 25) {
        if (this.running || !this.config.settlementCallbackEnabled) {
            return;
        }
        this.running = true;
        try {
            const due = await this.store.getDueCallbackDeliveries(limit, this.now().toISOString());
            for (const delivery of due) {
                await this.processDelivery(delivery.deliveryId);
            }
        }
        finally {
            this.running = false;
        }
    }
    async replayDeadLetterDelivery(deliveryId) {
        const requeued = await this.store.requeueCallbackDelivery(deliveryId, this.now().toISOString());
        if (!requeued) {
            throw new Error(`Settlement callback delivery is not eligible for replay: ${deliveryId}`);
        }
        await this.processDelivery(deliveryId);
    }
    async processDelivery(deliveryId) {
        const attemptedAt = this.now().toISOString();
        const delivery = await this.store.markCallbackDelivering(deliveryId, attemptedAt);
        if (!delivery) {
            return;
        }
        try {
            const callbackUrl = this.config.settlementCallbackUrl;
            const payload = delivery.requestBody;
            const url = new URL(callbackUrl);
            const headers = (0, serviceAuth_1.createServiceAuthHeaders)({
                apiKey: this.config.settlementCallbackApiKey,
                apiSecret: this.config.settlementCallbackApiSecret,
                method: 'POST',
                path: url.pathname,
                query: url.search,
                body: payload,
            });
            const response = await this.fetchImpl(callbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-Id': delivery.requestId,
                    ...headers,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(this.config.settlementCallbackRequestTimeoutMs),
            });
            if (response.ok) {
                await this.store.markCallbackDelivered(deliveryId, this.now().toISOString(), response.status);
                logger_1.Logger.info('Settlement callback delivered', {
                    deliveryId,
                    handoffId: delivery.handoffId,
                    eventId: delivery.eventId,
                    responseStatus: response.status,
                });
                return;
            }
            await this.scheduleFailure(delivery, `HTTP ${response.status}`, response.status);
        }
        catch (error) {
            await this.scheduleFailure(delivery, error instanceof Error ? error.message : String(error), null);
        }
    }
    async scheduleFailure(delivery, message, responseStatus) {
        const deadLetter = delivery.attemptCount >= this.config.settlementCallbackMaxAttempts;
        const nextAttemptAt = new Date(this.now().getTime()
            + computeBackoffMs(delivery.attemptCount, this.config.settlementCallbackInitialBackoffMs, this.config.settlementCallbackMaxBackoffMs)).toISOString();
        await this.store.markCallbackFailed(delivery.deliveryId, {
            attemptedAt: this.now().toISOString(),
            responseStatus,
            errorMessage: message,
            nextAttemptAt,
            deadLetter,
        });
        logger_1.Logger.warn('Settlement callback delivery failed', {
            deliveryId: delivery.deliveryId,
            handoffId: delivery.handoffId,
            eventId: delivery.eventId,
            responseStatus,
            deadLetter,
            error: message,
        });
        if (deadLetter && this.failedOperationWorkflow) {
            const callbackDelivery = await this.store.getCallbackDelivery(delivery.deliveryId);
            if (callbackDelivery) {
                await this.failedOperationWorkflow.captureSettlementCallbackDeadLetter({
                    deliveryId: callbackDelivery.deliveryId,
                    handoffId: callbackDelivery.handoffId,
                    eventId: callbackDelivery.eventId,
                    targetUrl: callbackDelivery.targetUrl,
                    requestId: callbackDelivery.requestId,
                    requestPayload: callbackDelivery.requestBody,
                    responseStatus,
                    errorMessage: message,
                });
            }
        }
    }
}
exports.SettlementCallbackDispatcher = SettlementCallbackDispatcher;
//# sourceMappingURL=settlementCallbackDispatcher.js.map