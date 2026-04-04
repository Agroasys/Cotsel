"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRicardianRouter = createRicardianRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
function createRicardianRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/ricardian/:tradeId', async (req, res, next) => {
        try {
            const tradeId = req.params.tradeId?.trim();
            if (!tradeId) {
                throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
            }
            const snapshot = await options.evidenceReadService.getRicardianDocument(tradeId);
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/evidence/:tradeId', async (req, res, next) => {
        try {
            const tradeId = req.params.tradeId?.trim();
            if (!tradeId) {
                throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
            }
            const snapshot = await options.evidenceReadService.getTradeEvidence(tradeId);
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=ricardian.js.map