"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRequestContextMiddleware = createRequestContextMiddleware;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = require("crypto");
const logger_1 = require("../logging/logger");
function createRequestContextMiddleware() {
    return (req, res, next) => {
        const requestId = headerValue(req.headers['x-request-id']) || (0, crypto_1.randomUUID)();
        const correlationId = headerValue(req.headers['x-correlation-id']) || requestId;
        const startedAtMs = Date.now();
        req.requestContext = { requestId, correlationId, startedAtMs };
        res.setHeader('x-request-id', requestId);
        res.setHeader('x-correlation-id', correlationId);
        logger_1.Logger.info('Request started', {
            requestId,
            correlationId,
            route: req.originalUrl || req.path,
            method: req.method,
        });
        res.on('finish', () => {
            logger_1.Logger.info('Request completed', {
                requestId,
                correlationId,
                route: req.originalUrl || req.path,
                method: req.method,
                statusCode: res.statusCode,
                durationMs: Date.now() - startedAtMs,
            });
        });
        next();
    };
}
function headerValue(value) {
    if (Array.isArray(value)) {
        return value[0]?.trim() || undefined;
    }
    return value?.trim() || undefined;
}
//# sourceMappingURL=requestContext.js.map