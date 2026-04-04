"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettlementRouter = createSettlementRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const errors_1 = require("../errors");
const idempotency_1 = require("../middleware/idempotency");
const responses_1 = require("../responses");
const serviceAuth_1 = require("../core/serviceAuth");
const settlementStore_1 = require("../core/settlementStore");
function requireObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be an object`);
    }
    return value;
}
function requireString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be a non-empty string`);
    }
    return value.trim();
}
function optionalString(value, field) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return requireString(value, field);
}
function requireNumber(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be a number`);
    }
    return value;
}
function requireEventType(value) {
    const eventType = requireString(value, 'eventType');
    if (!settlementStore_1.SETTLEMENT_EVENT_TYPES.includes(eventType)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'eventType is not supported', {
            allowed: settlementStore_1.SETTLEMENT_EVENT_TYPES,
        });
    }
    return eventType;
}
function requireExecutionStatus(value) {
    const executionStatus = requireString(value, 'executionStatus');
    if (!settlementStore_1.SETTLEMENT_EXECUTION_STATUSES.includes(executionStatus)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'executionStatus is not supported', {
            allowed: settlementStore_1.SETTLEMENT_EXECUTION_STATUSES,
        });
    }
    return executionStatus;
}
function requireReconciliationStatus(value) {
    const reconciliationStatus = requireString(value, 'reconciliationStatus');
    if (!settlementStore_1.SETTLEMENT_RECONCILIATION_STATUSES.includes(reconciliationStatus)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'reconciliationStatus is not supported', {
            allowed: settlementStore_1.SETTLEMENT_RECONCILIATION_STATUSES,
        });
    }
    return reconciliationStatus;
}
function optionalMetadata(value) {
    if (value === undefined || value === null) {
        return {};
    }
    return requireObject(value, 'metadata');
}
function getRequestId(req) {
    return req.requestContext?.requestId || 'unknown';
}
function getServiceApiKeyId(req) {
    return req.serviceAuth?.apiKeyId ?? null;
}
async function handleRequest(handler, res, next) {
    try {
        const payload = await handler();
        res.status(202).json((0, responses_1.successResponse)(payload));
    }
    catch (error) {
        next(error);
    }
}
function sanitizeSettlementHandoff(handoff) {
    const { extrinsicHash: _extrinsicHash, ...publicHandoff } = handoff;
    return publicHandoff;
}
function sanitizeSettlementExecutionEvent(event) {
    const { extrinsicHash: _extrinsicHash, ...publicEvent } = event;
    return publicEvent;
}
function createSettlementRouter(options) {
    const router = (0, express_1.Router)();
    const idempotency = (0, idempotency_1.createIdempotencyMiddleware)(options.idempotencyStore);
    const serviceAuth = (0, serviceAuth_1.createServiceAuthMiddleware)({
        enabled: options.config.settlementIngressEnabled,
        maxSkewSeconds: options.config.settlementServiceAuthMaxSkewSeconds,
        nonceTtlSeconds: options.config.settlementServiceAuthNonceTtlSeconds,
        sharedSecret: options.config.settlementServiceAuthSharedSecret,
        lookupApiKey: options.lookupServiceApiKey,
        consumeNonce: options.nonceStore.consume.bind(options.nonceStore),
    });
    router.use((req, _res, next) => {
        if (!options.config.settlementIngressEnabled) {
            next(new errors_1.GatewayError(403, 'FORBIDDEN', 'Settlement ingress is disabled', {
                reason: 'settlement_ingress_disabled',
            }));
            return;
        }
        next();
    });
    router.use(serviceAuth);
    router.post('/settlement/handoffs', idempotency, (req, res, next) => handleRequest(async () => {
        const body = requireObject(req.body, 'body');
        const handoff = await options.settlementService.createHandoff({
            platformId: requireString(body.platformId, 'platformId'),
            platformHandoffId: requireString(body.platformHandoffId, 'platformHandoffId'),
            tradeId: requireString(body.tradeId, 'tradeId'),
            phase: requireString(body.phase, 'phase'),
            settlementChannel: requireString(body.settlementChannel, 'settlementChannel'),
            displayCurrency: requireString(body.displayCurrency, 'displayCurrency'),
            displayAmount: requireNumber(body.displayAmount, 'displayAmount'),
            assetSymbol: optionalString(body.assetSymbol, 'assetSymbol'),
            assetAmount: body.assetAmount === undefined || body.assetAmount === null ? null : requireNumber(body.assetAmount, 'assetAmount'),
            ricardianHash: optionalString(body.ricardianHash, 'ricardianHash'),
            externalReference: optionalString(body.externalReference, 'externalReference'),
            metadata: optionalMetadata(body.metadata),
            requestId: getRequestId(req),
            sourceApiKeyId: getServiceApiKeyId(req),
        });
        return sanitizeSettlementHandoff(handoff);
    }, res, next));
    router.post('/settlement/handoffs/:handoffId/execution-events', idempotency, (req, res, next) => handleRequest(async () => {
        const handoffId = requireString(req.params.handoffId, 'handoffId');
        const body = requireObject(req.body, 'body');
        if (body.extrinsicHash !== undefined && body.extrinsicHash !== null && body.extrinsicHash !== '') {
            throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'extrinsicHash is retired from the active settlement ingress contract; use txHash');
        }
        const executionStatus = requireExecutionStatus(body.executionStatus);
        const txHash = optionalString(body.txHash, 'txHash');
        const result = await options.settlementService.recordExecutionEvent({
            handoffId,
            eventType: requireEventType(body.eventType),
            executionStatus,
            reconciliationStatus: requireReconciliationStatus(body.reconciliationStatus),
            providerStatus: optionalString(body.providerStatus, 'providerStatus'),
            txHash,
            detail: optionalString(body.detail, 'detail'),
            metadata: optionalMetadata(body.metadata),
            observedAt: requireString(body.observedAt, 'observedAt'),
            requestId: getRequestId(req),
            sourceApiKeyId: getServiceApiKeyId(req),
        });
        return {
            handoff: sanitizeSettlementHandoff(result.handoff),
            event: sanitizeSettlementExecutionEvent(result.event),
            callbackDelivery: result.callbackDelivery,
        };
    }, res, next));
    router.get('/settlement/handoffs/:handoffId/execution-events', async (req, res, next) => {
        try {
            const handoffId = requireString(req.params.handoffId, 'handoffId');
            const events = await options.settlementService.listExecutionEvents(handoffId);
            res.status(200).json((0, responses_1.successResponse)(events.map((event) => sanitizeSettlementExecutionEvent(event))));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=settlement.js.map