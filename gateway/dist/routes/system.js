"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSystemRouter = createSystemRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const responses_1 = require("../responses");
function createSystemRouter(options) {
    const router = (0, express_1.Router)();
    router.get('/healthz', (_req, res) => {
        res.status(200).json((0, responses_1.successResponse)({
            service: 'dashboard-gateway',
            status: 'ok',
        }));
    });
    router.get('/readyz', async (_req, res, next) => {
        try {
            const dependencies = await options.readinessCheck();
            const ready = dependencies.every((dependency) => dependency.status === 'ok');
            res.status(ready ? 200 : 503).json((0, responses_1.successResponse)({
                service: 'dashboard-gateway',
                ready,
                dependencies,
            }));
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/version', (_req, res) => {
        res.status(200).json((0, responses_1.successResponse)({
            service: 'dashboard-gateway',
            version: options.version,
            commitSha: options.commitSha,
            buildTime: options.buildTime,
            sourceRepo: 'Cotsel',
        }));
    });
    return router;
}
//# sourceMappingURL=system.js.map