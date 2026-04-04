"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceOrchestrator = void 0;
exports.executeHttpRequestWithPolicy = executeHttpRequestWithPolicy;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = __importDefault(require("crypto"));
const errors_1 = require("../errors");
const serviceAuth_1 = require("./serviceAuth");
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);
function normalizePath(pathname) {
    if (!pathname || pathname === '') {
        return '';
    }
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
}
function buildUrl(baseUrl, path, query) {
    const url = new URL(`${baseUrl}${normalizePath(path)}`);
    if (!query) {
        return url.toString();
    }
    if (query instanceof URLSearchParams) {
        url.search = query.toString();
        return url.toString();
    }
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
            continue;
        }
        url.searchParams.set(key, String(value));
    }
    return url.toString();
}
function serializeBody(body) {
    if (body === undefined || body === null) {
        return { requestBody: undefined, bodyForSigning: '' };
    }
    if (Buffer.isBuffer(body)) {
        return { requestBody: new Uint8Array(body), bodyForSigning: body };
    }
    if (typeof body === 'string') {
        return { requestBody: body, bodyForSigning: body };
    }
    const serialized = JSON.stringify(body);
    return { requestBody: serialized, bodyForSigning: serialized, contentType: 'application/json' };
}
function toSharedAuthHeaders(headers, style) {
    if (style === 'agroasys') {
        return {
            ...(headers['X-Api-Key'] ? { 'X-Api-Key': headers['X-Api-Key'] } : {}),
            'x-agroasys-timestamp': headers['X-Timestamp'],
            'x-agroasys-nonce': headers['X-Nonce'],
            'x-agroasys-signature': headers['X-Signature'],
        };
    }
    return { ...headers };
}
function createOracleLegacyAuthHeaders(auth, body) {
    if (!auth.apiKey || !auth.apiSecret) {
        throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gateway oracle auth contract is incomplete', {
            required: ['apiKey', 'apiSecret'],
            upstream: 'oracle',
        });
    }
    const timestamp = Date.now().toString();
    const bodyValue = typeof body === 'string' ? body : body.toString('utf8');
    const signature = crypto_1.default
        .createHmac('sha256', auth.apiSecret)
        .update(timestamp + bodyValue)
        .digest('hex');
    const nonce = crypto_1.default
        .createHash('sha256')
        .update([timestamp, bodyValue, signature].join(':'))
        .digest('hex');
    return {
        Authorization: `Bearer ${auth.apiKey}`,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
        'X-Nonce': nonce,
    };
}
function createAuthenticatedHeaders(service, input, bodyForSigning) {
    if (!input.authenticated || service.auth.mode === 'none') {
        return {};
    }
    if (service.auth.mode === 'oracle_legacy_hmac') {
        return createOracleLegacyAuthHeaders(service.auth, bodyForSigning);
    }
    if (!service.auth.apiSecret) {
        throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gateway service auth contract is incomplete', {
            upstream: service.key,
            required: ['apiSecret'],
        });
    }
    const url = buildUrl(service.baseUrl, input.path ?? '', input.query);
    const parsed = new URL(url);
    return toSharedAuthHeaders((0, serviceAuth_1.createServiceAuthHeaders)({
        apiKey: service.auth.apiKey ?? service.key,
        apiSecret: service.auth.apiSecret,
        method: input.method,
        path: parsed.pathname,
        query: parsed.searchParams.toString(),
        body: bodyForSigning,
    }), service.auth.headerStyle ?? 'agroasys');
}
function shouldRetry(options, failure, attemptsRemaining) {
    if (!options.readOnly || attemptsRemaining <= 0) {
        return false;
    }
    if (failure.responseStatus !== undefined) {
        return RETRYABLE_STATUS_CODES.has(failure.responseStatus);
    }
    if (failure.error instanceof errors_1.GatewayError) {
        return failure.error.code === 'UPSTREAM_UNAVAILABLE';
    }
    return true;
}
async function executeHttpRequestWithPolicy(input) {
    if (!input.service.baseUrl) {
        throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Downstream service is not configured', {
            upstream: input.service.key,
        });
    }
    const timeoutMs = input.timeoutMs ?? (input.readOnly ? input.service.readTimeoutMs : input.service.mutationTimeoutMs);
    const retryBudget = input.retryBudget ?? (input.readOnly ? input.service.readRetryBudget : input.service.mutationRetryBudget);
    const attempts = retryBudget + 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const { requestBody, bodyForSigning, contentType } = serializeBody(input.body);
        const headers = {
            Accept: 'application/json',
            ...(contentType ? { 'content-type': contentType } : {}),
            ...(input.requestContext?.requestId ? { 'x-request-id': input.requestContext.requestId } : {}),
            ...(input.requestContext?.correlationId ? { 'x-correlation-id': input.requestContext.correlationId } : {}),
            ...(input.headers ?? {}),
            ...createAuthenticatedHeaders(input.service, input, bodyForSigning),
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(buildUrl(input.service.baseUrl, input.path ?? '', input.query), {
                method: input.method,
                headers,
                body: requestBody,
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (response.ok || !shouldRetry(input, { responseStatus: response.status }, attempts - attempt)) {
                return response;
            }
        }
        catch (error) {
            clearTimeout(timeout);
            const normalizedError = error instanceof Error && error.name === 'AbortError'
                ? new errors_1.GatewayError(504, 'UPSTREAM_UNAVAILABLE', 'Downstream request timed out', {
                    upstream: input.service.key,
                    operation: input.operation,
                    timeoutMs,
                })
                : error instanceof errors_1.GatewayError
                    ? error
                    : new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Downstream request failed', {
                        upstream: input.service.key,
                        operation: input.operation,
                        reason: error instanceof Error ? error.message : String(error),
                    });
            lastError = normalizedError;
            if (!shouldRetry(input, { error: normalizedError }, attempts - attempt)) {
                throw normalizedError;
            }
            continue;
        }
    }
    throw lastError instanceof errors_1.GatewayError
        ? lastError
        : new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Downstream request failed', {
            upstream: input.service.key,
            operation: input.operation,
        });
}
class ServiceOrchestrator {
    constructor(registry) {
        this.registry = registry;
    }
    async fetch(serviceKey, options) {
        return executeHttpRequestWithPolicy({
            ...options,
            service: this.registry.get(serviceKey),
        });
    }
    async probeHealth(serviceKey, requestContext) {
        const service = this.registry.get(serviceKey);
        if (!service.baseUrl || !service.healthPath) {
            throw new Error('Gateway has no configured health probe for this service');
        }
        const response = await this.fetch(serviceKey, {
            method: 'GET',
            path: service.healthPath,
            readOnly: true,
            authenticated: false,
            requestContext,
            operation: `${service.key}:health`,
        });
        if (!response.ok) {
            throw new Error(`${service.name} health probe responded with HTTP ${response.status}`);
        }
    }
}
exports.ServiceOrchestrator = ServiceOrchestrator;
//# sourceMappingURL=serviceOrchestrator.js.map