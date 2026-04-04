"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthSessionClient = createAuthSessionClient;
const errors_1 = require("../errors");
const logger_1 = require("../logging/logger");
function buildUrl(baseUrl, pathname) {
    return `${baseUrl}${pathname}`;
}
function createAuthSessionClient(config) {
    return {
        async resolveSession(token, requestId) {
            const response = await fetch(buildUrl(config.authBaseUrl, '/api/auth/v1/session'), {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(requestId ? { 'x-request-id': requestId } : {}),
                },
                signal: AbortSignal.timeout(config.authRequestTimeoutMs),
            }).catch((error) => {
                logger_1.Logger.error('Auth session lookup failed', { requestId, error: error instanceof Error ? error.message : String(error) });
                throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service is unavailable');
            });
            if (response.status === 401) {
                return null;
            }
            if (!response.ok) {
                throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service session lookup failed', {
                    upstreamStatus: response.status,
                });
            }
            const payload = (await response.json());
            if (!payload.success || !payload.data) {
                throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service returned an invalid session payload');
            }
            return payload.data;
        },
        async checkReadiness(requestId) {
            const response = await fetch(buildUrl(config.authBaseUrl, '/api/auth/v1/health'), {
                method: 'GET',
                headers: requestId ? { 'x-request-id': requestId } : undefined,
                signal: AbortSignal.timeout(config.authRequestTimeoutMs),
            }).catch(() => {
                throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service is unavailable');
            });
            if (!response.ok) {
                throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Auth service readiness check failed', {
                    upstreamStatus: response.status,
                });
            }
        },
    };
}
//# sourceMappingURL=authSessionClient.js.map