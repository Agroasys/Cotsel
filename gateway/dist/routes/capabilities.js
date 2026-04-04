"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCapabilitiesRouter = createCapabilitiesRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const operatorCapabilities_1 = require("../core/operatorCapabilities");
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
function createCapabilitiesRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate);
    router.get('/auth/capabilities', async (req, res, next) => {
        try {
            if (!req.gatewayPrincipal) {
                throw new errors_1.GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
            }
            const snapshot = (0, operatorCapabilities_1.buildOperatorCapabilitySnapshot)(req.gatewayPrincipal, options.config);
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=capabilities.js.map