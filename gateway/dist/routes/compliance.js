"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createComplianceRouter = createComplianceRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const complianceService_1 = require("../core/complianceService");
const complianceStore_1 = require("../core/complianceStore");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const idempotency_1 = require("../middleware/idempotency");
const responses_1 = require("../responses");
function parseTradeId(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
    }
    return raw.trim();
}
function parseDecisionId(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter decisionId is required');
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
function parseCursor(raw) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' must be a non-empty string");
    }
    try {
        (0, complianceStore_1.decodeComplianceDecisionCursor)(raw);
    }
    catch (error) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
            reason: error instanceof Error ? error.message : String(error),
        });
    }
    return raw;
}
function getMutationContext(req) {
    if (!req.gatewayPrincipal) {
        throw new errors_1.GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    if (!req.requestContext) {
        throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
    }
    if (!req.idempotencyState?.idempotencyKey) {
        throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Idempotency context was not initialized');
    }
    return {
        principal: req.gatewayPrincipal,
        requestContext: req.requestContext,
        idempotencyKey: req.idempotencyState.idempotencyKey,
    };
}
async function handleMutation(req, res, next, statusCode, options, failureCapture, operation) {
    try {
        const result = await operation();
        res.status(statusCode).json((0, responses_1.successResponse)(result));
    }
    catch (error) {
        if (options.failedOperationWorkflow) {
            const failedOperation = await options.failedOperationWorkflow.captureFailure({
                operationType: failureCapture.replaySpec.type,
                operationKey: `${(0, auth_1.resolveGatewayActorKey)(failureCapture.principal.session)}:${req.originalUrl || req.path}:${failureCapture.idempotencyKey}`,
                targetService: 'gateway_compliance_write',
                route: req.originalUrl || req.path,
                method: req.method,
                requestContext: failureCapture.requestContext,
                requestPayload: req.body,
                idempotencyKey: failureCapture.idempotencyKey,
                principal: failureCapture.principal,
                replaySpec: failureCapture.replaySpec,
                error,
            });
            if (failedOperation) {
                next(options.failedOperationWorkflow.buildClientError(failedOperation, failureCapture.requestContext));
                return;
            }
        }
        next(error);
    }
}
function createComplianceRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    const idempotency = (0, idempotency_1.createIdempotencyMiddleware)(options.idempotencyStore);
    router.use(authenticate);
    router.get('/compliance/decisions/:decisionId', (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const decisionId = parseDecisionId(req.params.decisionId);
            const decision = await options.complianceService.getDecision(decisionId);
            if (!decision) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Compliance decision not found', { decisionId });
            }
            res.status(200).json((0, responses_1.successResponse)(decision));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/compliance/trades/:tradeId', (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const tradeId = parseTradeId(req.params.tradeId);
            const status = await options.complianceService.getTradeStatus(tradeId);
            if (!status) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Compliance status not found for trade', { tradeId });
            }
            res.status(200).json((0, responses_1.successResponse)(status));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/compliance/trades/:tradeId/attestation-status', (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const tradeId = parseTradeId(req.params.tradeId);
            const status = await options.complianceService.getAttestationStatus(tradeId);
            if (!status) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Attestation status not found for trade', { tradeId });
            }
            res.status(200).json((0, responses_1.successResponse)(status));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/compliance/trades/:tradeId/decisions', (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const tradeId = parseTradeId(req.params.tradeId);
            const latest = await options.complianceService.getTradeStatus(tradeId);
            if (!latest) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Compliance decision history not found for trade', { tradeId });
            }
            const result = await options.complianceService.listTradeDecisions(tradeId, parseLimit(req.query.limit), parseCursor(req.query.cursor));
            res.status(200).json((0, responses_1.successResponse)(result));
        }
        catch (error) {
            next(error);
        }
    });
    router.post('/compliance/decisions', (0, auth_1.requireMutationWriteAccess)(), idempotency, (req, res, next) => handleMutation(req, res, next, 201, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'compliance.create_decision',
                routePath: req.originalUrl || req.path,
                payload: (0, complianceService_1.validateComplianceDecisionCreateRequest)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const payload = (0, complianceService_1.validateComplianceDecisionCreateRequest)(req.body);
        return options.complianceService.createDecision({
            ...payload,
            principal,
            requestContext,
            routePath: req.originalUrl || req.path,
            idempotencyKey,
        });
    }));
    router.post('/compliance/trades/:tradeId/block-oracle-progression', (0, auth_1.requireMutationWriteAccess)(), idempotency, (req, res, next) => handleMutation(req, res, next, 202, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'compliance.block_oracle_progression',
                routePath: req.originalUrl || req.path,
                payload: {
                    ...(0, complianceService_1.validateComplianceOperationalControlRequest)(req.body),
                    tradeId: parseTradeId(req.params.tradeId),
                },
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const payload = (0, complianceService_1.validateComplianceOperationalControlRequest)(req.body);
        return options.complianceService.blockOracleProgression({
            ...payload,
            tradeId: parseTradeId(req.params.tradeId),
            principal,
            requestContext,
            routePath: req.originalUrl || req.path,
            idempotencyKey,
        });
    }));
    router.post('/compliance/trades/:tradeId/resume-oracle-progression', (0, auth_1.requireMutationWriteAccess)(), idempotency, (req, res, next) => handleMutation(req, res, next, 202, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'compliance.resume_oracle_progression',
                routePath: req.originalUrl || req.path,
                payload: {
                    ...(0, complianceService_1.validateComplianceOperationalControlRequest)(req.body),
                    tradeId: parseTradeId(req.params.tradeId),
                },
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const payload = (0, complianceService_1.validateComplianceOperationalControlRequest)(req.body);
        return options.complianceService.resumeOracleProgression({
            ...payload,
            tradeId: parseTradeId(req.params.tradeId),
            principal,
            requestContext,
            routePath: req.originalUrl || req.path,
            idempotencyKey,
        });
    }));
    return router;
}
//# sourceMappingURL=compliance.js.map