"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGovernanceRouter = createGovernanceRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
const governanceStore_1 = require("../core/governanceStore");
const errors_1 = require("../errors");
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
        (0, governanceStore_1.decodeGovernanceActionCursor)(raw);
    }
    catch (error) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
            reason: error instanceof Error ? error.message : String(error),
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
function createGovernanceRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/governance/status', async (_req, res, next) => {
        try {
            const [oracleProposalIds, treasuryPayoutReceiverProposalIds] = await Promise.all([
                options.governanceActionStore.listActiveProposalIds('oracle_update'),
                options.governanceActionStore.listActiveProposalIds('treasury_payout_receiver_update'),
            ]);
            const status = await options.governanceStatusService.getGovernanceStatus({
                oracleProposalIds,
                treasuryPayoutReceiverProposalIds,
            });
            res.status(200).json((0, responses_1.successResponse)(status));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/governance/actions', async (req, res, next) => {
        try {
            const result = await options.governanceActionStore.list({
                category: parseEnum(req.query.category, governanceStore_1.GOVERNANCE_ACTION_CATEGORIES, 'category'),
                status: parseEnum(req.query.status, governanceStore_1.GOVERNANCE_ACTION_STATUSES, 'status'),
                tradeId: parseTradeId(req.query.tradeId),
                limit: parseLimit(req.query.limit),
                cursor: parseCursor(req.query.cursor),
            });
            res.status(200).json((0, responses_1.successResponse)(result));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/governance/actions/:actionId', async (req, res, next) => {
        try {
            const actionId = req.params.actionId?.trim();
            if (!actionId) {
                throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter actionId is required');
            }
            const action = await options.governanceActionStore.get(actionId);
            if (!action) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Governance action not found', {
                    actionId,
                });
            }
            res.status(200).json((0, responses_1.successResponse)(action));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=governance.js.map