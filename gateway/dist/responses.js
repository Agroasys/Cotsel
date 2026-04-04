"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isoTimestamp = isoTimestamp;
exports.successResponse = successResponse;
exports.errorResponse = errorResponse;
function isoTimestamp() {
    return new Date().toISOString();
}
function successResponse(data) {
    return {
        success: true,
        data,
        timestamp: isoTimestamp(),
    };
}
function errorResponse(requestContext, code, message, details) {
    return {
        success: false,
        error: {
            code,
            message,
            requestId: requestContext?.requestId,
            traceId: requestContext?.correlationId,
            ...(details ? { details } : {}),
        },
        timestamp: isoTimestamp(),
    };
}
//# sourceMappingURL=responses.js.map