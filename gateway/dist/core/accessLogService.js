"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccessLogService = void 0;
exports.validateAccessLogCreateRequest = validateAccessLogCreateRequest;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = require("crypto");
const net_1 = require("net");
const accessLogStore_1 = require("./accessLogStore");
const errors_1 = require("../errors");
function validatePattern(value, field, min, max, pattern) {
    if (typeof value !== 'string') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length < min || trimmed.length > max) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be between ${min} and ${max} characters`);
    }
    if (pattern && !pattern.test(trimmed)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} contains invalid characters`);
    }
    return trimmed;
}
function validateAuditReferences(value) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'auditReferences must be an array');
    }
    return value.map((item, index) => {
        if (!item || typeof item !== 'object') {
            throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `auditReferences[${index}] must be an object`);
        }
        const record = item;
        const type = validatePattern(record.type, `auditReferences[${index}].type`, 3, 64);
        if (!accessLogStore_1.ACCESS_AUDIT_REFERENCE_TYPES.includes(type)) {
            throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `auditReferences[${index}].type is invalid`, {
                allowed: accessLogStore_1.ACCESS_AUDIT_REFERENCE_TYPES,
            });
        }
        return {
            type,
            reference: validatePattern(record.reference, `auditReferences[${index}].reference`, 2, 256),
        };
    });
}
function validateMetadata(value) {
    if (value === undefined) {
        return {};
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'metadata must be an object');
    }
    return { ...value };
}
function hashValue(value) {
    return `sha256:${(0, crypto_1.createHash)('sha256').update(value, 'utf8').digest('hex')}`;
}
function maskSessionFingerprint(fingerprint) {
    if (fingerprint.length <= 18) {
        return '[REDACTED]';
    }
    return `${fingerprint.slice(0, 11)}...${fingerprint.slice(-6)}`;
}
function normalizeIp(value) {
    if (!value) {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    if (trimmed.startsWith('::ffff:')) {
        return trimmed.slice(7);
    }
    return trimmed;
}
function maskIpAddress(ip) {
    if ((0, net_1.isIP)(ip) === 4) {
        const octets = ip.split('.');
        return `${octets[0]}.${octets[1]}.${octets[2]}.x`;
    }
    if ((0, net_1.isIP)(ip) === 6) {
        const segments = ip.split(':').filter((segment) => segment.length > 0);
        const [first = '::', second = ''] = segments;
        return `${first}:${second}:****:****:****:****`;
    }
    return '[REDACTED]';
}
function sourceFreshAt(items) {
    if (items.length === 0) {
        return null;
    }
    return items[0].createdAt;
}
function validateAccessLogCreateRequest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Request body must be an object');
    }
    const body = raw;
    return {
        eventType: validatePattern(body.eventType, 'eventType', 3, 128, /^[A-Za-z0-9._:-]+$/),
        surface: validatePattern(body.surface, 'surface', 1, 256),
        outcome: validatePattern(body.outcome, 'outcome', 2, 64, /^[A-Za-z0-9._:-]+$/),
        auditReferences: validateAuditReferences(body.auditReferences),
        metadata: validateMetadata(body.metadata),
    };
}
class AccessLogService {
    constructor(store, now = () => new Date(), idFactory = () => (0, crypto_1.randomUUID)()) {
        this.store = store;
        this.now = now;
        this.idFactory = idFactory;
    }
    async record(input, principal, requestContext, request) {
        const createdAt = this.now().toISOString();
        const ip = normalizeIp(request.ip);
        return this.store.append({
            entryId: this.idFactory(),
            eventType: input.eventType,
            surface: input.surface,
            outcome: input.outcome,
            actor: {
                userId: principal.session.userId,
                walletAddress: principal.session.walletAddress,
                role: principal.session.role,
                sessionFingerprint: principal.sessionReference,
                sessionDisplay: maskSessionFingerprint(principal.sessionReference),
            },
            network: {
                ipFingerprint: ip ? hashValue(ip) : null,
                ipDisplay: ip ? maskIpAddress(ip) : null,
                userAgent: request.get('user-agent')?.trim() || null,
            },
            request: {
                requestId: requestContext.requestId,
                correlationId: requestContext.correlationId,
                method: request.method,
                route: request.originalUrl || request.path,
            },
            auditReferences: input.auditReferences,
            metadata: input.metadata,
            createdAt,
        });
    }
    async list(input) {
        const result = await this.store.list(input);
        return {
            items: result.items,
            nextCursor: result.nextCursor,
            freshness: {
                source: 'gateway_access_log',
                sourceFreshAt: sourceFreshAt(result.items),
                queriedAt: this.now().toISOString(),
                available: true,
            },
        };
    }
    async get(entryId) {
        const item = await this.store.get(entryId);
        if (!item) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Access log entry not found', { entryId });
        }
        return {
            item,
            freshness: {
                source: 'gateway_access_log',
                sourceFreshAt: item.createdAt,
                queriedAt: this.now().toISOString(),
                available: true,
            },
        };
    }
}
exports.AccessLogService = AccessLogService;
//# sourceMappingURL=accessLogService.js.map