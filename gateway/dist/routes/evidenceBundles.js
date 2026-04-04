"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEvidenceBundleRouter = createEvidenceBundleRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const idempotency_1 = require("../middleware/idempotency");
const responses_1 = require("../responses");
function parseTradeId(value) {
    const tradeId = typeof value === 'string' ? value.trim() : '';
    if (!tradeId) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'tradeId is required');
    }
    if (tradeId.length > 128) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'tradeId must be 128 characters or fewer');
    }
    return tradeId;
}
function parseBundleId(value) {
    const bundleId = typeof value === 'string' ? value.trim() : '';
    if (!bundleId) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter bundleId is required');
    }
    return bundleId;
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
    };
}
function createEvidenceBundleRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    const idempotency = (0, idempotency_1.createIdempotencyMiddleware)(options.idempotencyStore);
    router.use(authenticate);
    router.post('/evidence/bundles', (0, auth_1.requireMutationWriteAccess)(), idempotency, async (req, res, next) => {
        try {
            const { principal, requestContext } = getMutationContext(req);
            const manifest = await options.evidenceBundleService.generate({
                tradeId: parseTradeId(req.body?.tradeId),
                principal,
                requestContext,
            });
            res.status(201).json((0, responses_1.successResponse)(manifest));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/evidence/bundles/:bundleId', (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const bundleId = parseBundleId(req.params.bundleId);
            const manifest = await options.evidenceBundleService.get(bundleId);
            if (!manifest) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Evidence bundle not found', {
                    bundleId,
                });
            }
            res.status(200).json((0, responses_1.successResponse)(manifest));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/evidence/bundles/:bundleId/download', (0, auth_1.requireGatewayRole)('operator:read'), async (req, res, next) => {
        try {
            const bundleId = parseBundleId(req.params.bundleId);
            const manifest = await options.evidenceBundleService.get(bundleId);
            if (!manifest) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Evidence bundle not found', {
                    bundleId,
                });
            }
            res
                .status(200)
                .setHeader('content-type', 'application/json; charset=utf-8')
                .setHeader('content-disposition', `attachment; filename=\"evidence-bundle-${bundleId}.json\"`)
                .json(manifest);
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=evidenceBundles.js.map