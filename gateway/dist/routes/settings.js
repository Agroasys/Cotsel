"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettingsRouter = createSettingsRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const auditFeedStore_1 = require("../core/auditFeedStore");
const roleAssignmentStore_1 = require("../core/roleAssignmentStore");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
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
function parseString(raw, field) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `Query parameter '${field}' must be a non-empty string`);
    }
    return raw.trim();
}
function parseCursor(raw, decoder) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' must be a non-empty string");
    }
    try {
        decoder(raw);
    }
    catch (error) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
            reason: error instanceof Error ? error.message : String(error),
        });
    }
    return raw;
}
function createSettingsRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/settings/role-assignments', async (req, res, next) => {
        try {
            const snapshot = await options.settingsReadService.listRoleAssignments({
                gatewayRole: parseString(req.query.gatewayRole, 'gatewayRole'),
                authRole: parseString(req.query.authRole, 'authRole'),
                limit: parseLimit(req.query.limit),
                cursor: parseCursor(req.query.cursor, roleAssignmentStore_1.decodeRoleAssignmentCursor),
            });
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/settings/audit-feed', async (req, res, next) => {
        try {
            const snapshot = await options.settingsReadService.listAuditFeed({
                eventType: parseString(req.query.eventType, 'eventType'),
                actorUserId: parseString(req.query.actorUserId, 'actorUserId'),
                limit: parseLimit(req.query.limit),
                cursor: parseCursor(req.query.cursor, auditFeedStore_1.decodeAuditFeedCursor),
            });
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=settings.js.map