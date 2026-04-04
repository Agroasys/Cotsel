"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFoundHandler = notFoundHandler;
exports.errorHandler = errorHandler;
const errors_1 = require("../errors");
const logger_1 = require("../logging/logger");
const responses_1 = require("../responses");
const errorEnvelope_1 = require("../core/errorEnvelope");
function notFoundHandler(req, res) {
    res.status(404).json((0, responses_1.errorResponse)(req.requestContext, 'NOT_FOUND', 'Route not found', {
        route: req.originalUrl || req.path,
        method: req.method,
    }));
}
function errorHandler(err, req, res, _next) {
    const envelope = (0, errorEnvelope_1.createGatewayErrorEnvelope)(err, req.requestContext);
    const requestId = envelope.requestId;
    const correlationId = envelope.traceId;
    if (err instanceof errors_1.GatewayError) {
        logger_1.Logger.warn('Gateway error response', {
            requestId,
            correlationId,
            route: req.originalUrl || req.path,
            method: req.method,
            statusCode: envelope.statusCode,
            errorCode: envelope.code,
            failureClass: envelope.failureClass,
            retryable: envelope.retryable,
            replayable: envelope.replayable,
            details: envelope.details,
        });
        res.status(envelope.statusCode).json((0, responses_1.errorResponse)(req.requestContext, envelope.code, envelope.message, envelope.details));
        return;
    }
    logger_1.Logger.error('Unhandled gateway error', {
        requestId,
        correlationId,
        route: req.originalUrl || req.path,
        method: req.method,
        failureClass: envelope.failureClass,
        retryable: envelope.retryable,
        replayable: envelope.replayable,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(500).json((0, responses_1.errorResponse)(req.requestContext, 'INTERNAL_ERROR', 'An unexpected error occurred'));
}
//# sourceMappingURL=errorHandler.js.map