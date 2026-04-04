"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTradeRouter = createTradeRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
function parseLimit(raw) {
    if (raw === undefined) {
        return 100;
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
function createTradeRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/trades', async (req, res, next) => {
        try {
            const records = await options.tradeReadService.listTrades(parseLimit(req.query.limit), parseOffset(req.query.offset));
            res.status(200).json((0, responses_1.successResponse)(records));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/trades/:tradeId', async (req, res, next) => {
        try {
            const tradeId = req.params.tradeId?.trim();
            if (!tradeId) {
                throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
            }
            const record = await options.tradeReadService.getTrade(tradeId);
            if (!record) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Trade not found', { tradeId });
            }
            res.status(200).json((0, responses_1.successResponse)(record));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=trades.js.map