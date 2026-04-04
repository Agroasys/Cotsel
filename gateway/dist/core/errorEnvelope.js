"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGatewayErrorEnvelope = createGatewayErrorEnvelope;
const errors_1 = require("../errors");
function classifyGatewayErrorCode(error) {
    if (error.code === 'UPSTREAM_UNAVAILABLE' || error.statusCode >= 500) {
        return 'infrastructure';
    }
    if (error.code === 'AUTH_REQUIRED'
        || error.code === 'FORBIDDEN'
        || error.code === 'VALIDATION_ERROR'
        || error.code === 'NOT_FOUND') {
        return 'client_contract';
    }
    return 'upstream_business';
}
function createGatewayErrorEnvelope(error, requestContext) {
    if (error instanceof errors_1.GatewayError) {
        const failureClass = classifyGatewayErrorCode(error);
        const retryable = failureClass === 'infrastructure';
        return {
            statusCode: error.statusCode,
            code: error.code,
            message: error.message,
            requestId: requestContext?.requestId,
            traceId: requestContext?.correlationId,
            ...(error.details ? { details: error.details } : {}),
            failureClass,
            retryable,
            replayable: retryable,
        };
    }
    return {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: requestContext?.requestId,
        traceId: requestContext?.correlationId,
        details: {
            reason: error instanceof Error ? error.message : String(error),
        },
        failureClass: 'unexpected',
        retryable: true,
        replayable: true,
    };
}
//# sourceMappingURL=errorEnvelope.js.map