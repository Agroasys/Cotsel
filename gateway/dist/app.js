"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const requestContext_1 = require("./middleware/requestContext");
const errorHandler_1 = require("./middleware/errorHandler");
const system_1 = require("./routes/system");
function createApp(config, dependencies) {
    const app = (0, express_1.default)();
    app.use((0, helmet_1.default)());
    app.use((0, cors_1.default)());
    app.use((0, requestContext_1.createRequestContextMiddleware)());
    app.use(express_1.default.json({
        verify: (req, _res, buffer) => {
            req.rawBody = Buffer.from(buffer);
        },
    }));
    app.use('/api/dashboard-gateway/v1', (0, system_1.createSystemRouter)({
        version: dependencies.version,
        commitSha: dependencies.commitSha,
        buildTime: dependencies.buildTime,
        readinessCheck: dependencies.readinessCheck,
    }));
    if (dependencies.extraRouter) {
        app.use('/api/dashboard-gateway/v1', dependencies.extraRouter);
    }
    app.use(errorHandler_1.notFoundHandler);
    app.use(errorHandler_1.errorHandler);
    return app;
}
//# sourceMappingURL=app.js.map