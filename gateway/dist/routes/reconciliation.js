"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReconciliationRouter = createReconciliationRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const settlementStore_1 = require("../core/settlementStore");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
function parseEnum(raw, values, field) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || !values.includes(raw)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `Query parameter '${field}' is invalid`, {
            field,
            allowed: values,
        });
    }
    return raw;
}
function parseTradeId(raw) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'tradeId' must be a non-empty string");
    }
    return raw.trim();
}
function parseLimit(raw) {
    if (raw === undefined) {
        return 50;
    }
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be an integer");
    }
    const limit = Number.parseInt(raw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be between 1 and 200");
    }
    return limit;
}
function parseOffset(raw) {
    if (raw === undefined) {
        return 0;
    }
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'offset' must be an integer");
    }
    const offset = Number.parseInt(raw, 10);
    if (!Number.isInteger(offset) || offset < 0) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'offset' must be zero or greater");
    }
    return offset;
}
function createReconciliationRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/reconciliation', async (req, res, next) => {
        try {
            const snapshot = await options.reconciliationReadService.listReconciliation({
                tradeId: parseTradeId(req.query.tradeId),
                reconciliationStatus: parseEnum(req.query.reconciliationStatus, settlementStore_1.SETTLEMENT_RECONCILIATION_STATUSES, 'reconciliationStatus'),
                executionStatus: parseEnum(req.query.executionStatus, settlementStore_1.SETTLEMENT_EXECUTION_STATUSES, 'executionStatus'),
                limit: parseLimit(req.query.limit),
                offset: parseOffset(req.query.offset),
            });
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/reconciliation/handoffs/:handoffId', async (req, res, next) => {
        try {
            const handoffId = req.params.handoffId?.trim();
            if (!handoffId) {
                throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter handoffId is required');
            }
            const snapshot = await options.reconciliationReadService.getReconciliationHandoff(handoffId);
            if (!snapshot.handoff && snapshot.freshness.available) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', { handoffId });
            }
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=reconciliation.js.map