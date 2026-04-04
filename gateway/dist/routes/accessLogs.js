"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAccessLogRouter = createAccessLogRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const accessLogService_1 = require("../core/accessLogService");
const accessLogStore_1 = require("../core/accessLogStore");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const idempotency_1 = require("../middleware/idempotency");
const responses_1 = require("../responses");
function getPathParam(value, field) {
    if (Array.isArray(value)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `Path parameter ${field} must be a string`);
    }
    return value;
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
function parseString(raw, field) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `Query parameter '${field}' must be a non-empty string`);
    }
    return raw.trim();
}
function parseCursor(raw) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' must be a non-empty string");
    }
    try {
        (0, accessLogStore_1.decodeAccessLogCursor)(raw);
    }
    catch (error) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
            reason: error instanceof Error ? error.message : String(error),
        });
    }
    return raw;
}
function createAccessLogRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    const idempotency = (0, idempotency_1.createIdempotencyMiddleware)(options.idempotencyStore);
    router.get('/access-logs', authenticate, (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const snapshot = await options.accessLogService.list({
                eventType: parseString(req.query.eventType, 'eventType'),
                outcome: parseString(req.query.outcome, 'outcome'),
                actorUserId: parseString(req.query.actorUserId, 'actorUserId'),
                limit: parseLimit(req.query.limit),
                cursor: parseCursor(req.query.cursor),
            });
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/access-logs/:entryId', authenticate, (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const entryId = getPathParam(req.params.entryId, 'entryId')?.trim();
            if (!entryId) {
                throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter entryId is required');
            }
            const snapshot = await options.accessLogService.get(entryId);
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    router.post('/access-logs', authenticate, (0, auth_1.requireMutationWriteAccess)(), idempotency, async (req, res, next) => {
        try {
            if (!req.gatewayPrincipal) {
                throw new errors_1.GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
            }
            if (!req.requestContext) {
                throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
            }
            const created = await options.accessLogService.record((0, accessLogService_1.validateAccessLogCreateRequest)(req.body), req.gatewayPrincipal, req.requestContext, req);
            res.status(201).json((0, responses_1.successResponse)({
                item: created,
                freshness: {
                    source: 'gateway_access_log',
                    sourceFreshAt: created.createdAt,
                    queriedAt: new Date().toISOString(),
                    available: true,
                },
            }));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=accessLogs.js.map