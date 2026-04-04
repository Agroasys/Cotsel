"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOperationsRouter = createOperationsRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const responses_1 = require("../responses");
function createOperationsRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    router.use(authenticate, (0, auth_1.requireGatewayRole)('operator:read'));
    router.get('/operations/summary', async (_req, res, next) => {
        try {
            const snapshot = await options.operationsSummaryService.getOperationsSummary();
            res.status(200).json((0, responses_1.successResponse)(snapshot));
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=operations.js.map