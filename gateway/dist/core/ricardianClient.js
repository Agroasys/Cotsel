"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RicardianClient = void 0;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const errors_1 = require("../errors");
async function parseOptionalJson(response) {
    const text = await response.text();
    if (!text.trim()) {
        return null;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function isDocumentRecord(value) {
    return Boolean(value
        && typeof value === 'object'
        && typeof value.hash === 'string'
        && typeof value.documentRef === 'string'
        && typeof value.requestId === 'string'
        && typeof value.createdAt === 'string');
}
class RicardianClient {
    constructor(orchestratorOrBaseUrl, requestTimeoutMs) {
        if (typeof orchestratorOrBaseUrl === 'string' || orchestratorOrBaseUrl === undefined) {
            this.baseUrl = orchestratorOrBaseUrl;
            this.requestTimeoutMs = requestTimeoutMs;
            return;
        }
        this.orchestrator = orchestratorOrBaseUrl;
    }
    async getDocument(hash) {
        try {
            const response = this.orchestrator
                ? await this.orchestrator.fetch('ricardian', {
                    method: 'GET',
                    path: `/api/ricardian/v1/hash/${encodeURIComponent(hash)}`,
                    readOnly: true,
                    authenticated: true,
                    operation: 'ricardian:getDocument',
                })
                : await this.fetchLegacy(hash);
            const payload = await parseOptionalJson(response);
            if (response.status === 404) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Ricardian document not found', {
                    hash,
                    upstream: 'ricardian',
                });
            }
            if (!response.ok) {
                throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Ricardian service request failed', {
                    upstream: 'ricardian',
                    status: response.status,
                    reason: payload?.error ?? null,
                    code: payload?.code ?? null,
                });
            }
            if (!payload?.success || !isDocumentRecord(payload.data)) {
                throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Ricardian service returned an invalid payload', {
                    upstream: 'ricardian',
                });
            }
            return payload.data;
        }
        catch (error) {
            if (error instanceof errors_1.GatewayError) {
                throw error;
            }
            throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Ricardian service request failed', {
                upstream: 'ricardian',
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async fetchLegacy(hash) {
        if (!this.baseUrl) {
            throw new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Ricardian service is not configured', {
                upstream: 'ricardian',
            });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs ?? 5000);
        try {
            return await fetch(`${this.baseUrl}/hash/${encodeURIComponent(hash)}`, {
                method: 'GET',
                signal: controller.signal,
            });
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new errors_1.GatewayError(504, 'UPSTREAM_UNAVAILABLE', 'Ricardian service request timed out', {
                    upstream: 'ricardian',
                    timeoutMs: this.requestTimeoutMs ?? 5000,
                });
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
exports.RicardianClient = RicardianClient;
//# sourceMappingURL=ricardianClient.js.map