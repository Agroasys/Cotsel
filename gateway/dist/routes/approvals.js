"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApprovalWorkflowRouter = createApprovalWorkflowRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const approvalWorkflowReadService_1 = require("../core/approvalWorkflowReadService");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
const governanceStore_1 = require("../core/governanceStore");
const errors_1 = require("../errors");
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
function parseCategory(raw) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || !approvalWorkflowReadService_1.APPROVAL_WORKFLOW_CATEGORIES.includes(raw)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'category' is invalid", {
            field: 'category',
            allowed: approvalWorkflowReadService_1.APPROVAL_WORKFLOW_CATEGORIES,
        });
    }
    return raw;
}
function createApprovalWorkflowRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/approvals', async (req, res, next) => {
        try {
            const result = await options.approvalWorkflowReadService.list({
                category: parseCategory(req.query.category),
                limit: parseLimit(req.query.limit),
                cursor: parseCursor(req.query.cursor),
            });
            res.status(200).json((0, responses_1.successResponse)(result));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/approvals/:approvalId', async (req, res, next) => {
        try {
            const approvalId = req.params.approvalId?.trim();
            if (!approvalId) {
                throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter approvalId is required');
            }
            const workflow = await options.approvalWorkflowReadService.get(approvalId);
            if (!workflow) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Approval workflow not found', {
                    approvalId,
                });
            }
            res.status(200).json((0, responses_1.successResponse)(workflow));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=approvals.js.map