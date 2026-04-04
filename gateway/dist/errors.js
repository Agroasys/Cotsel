"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayError = void 0;
class GatewayError extends Error {
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = 'GatewayError';
    }
}
exports.GatewayError = GatewayError;
//# sourceMappingURL=errors.js.map