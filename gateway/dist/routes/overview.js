"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOverviewRouter = createOverviewRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
function createOverviewRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/overview', async (_req, res, next) => {
        try {
            const snapshot = await options.overviewService.getOverview();
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=overview.js.map