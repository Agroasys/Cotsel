"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTreasuryRouter = createTreasuryRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const governanceStore_1 = require("../core/governanceStore");
const treasuryReadService_1 = require("../core/treasuryReadService");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
const governanceStore_2 = require("../core/governanceStore");
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
function parseCursor(raw) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' must be a non-empty string");
    }
    try {
        (0, governanceStore_2.decodeGovernanceActionCursor)(raw);
    }
    catch (error) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
            reason: error instanceof Error ? error.message : String(error),
        });
    }
    return raw;
}
function createTreasuryRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/treasury', async (_req, res, next) => {
        try {
            const snapshot = await options.treasuryReadService.getTreasurySnapshot();
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/treasury/actions', async (req, res, next) => {
        try {
            const result = await options.treasuryReadService.listTreasuryActions({
                category: parseEnum(req.query.category, treasuryReadService_1.TREASURY_ACTION_CATEGORIES, 'category'),
                status: parseEnum(req.query.status, governanceStore_1.GOVERNANCE_ACTION_STATUSES, 'status'),
                limit: parseLimit(req.query.limit),
                cursor: parseCursor(req.query.cursor),
            });
            res.status(200).json((0, responses_1.successResponse)(result));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=treasury.js.map