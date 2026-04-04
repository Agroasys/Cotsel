"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createIdempotencyMiddleware = createIdempotencyMiddleware;
const errors_1 = require("../errors");
const idempotencyStore_1 = require("../core/idempotencyStore");
function resolveActorId(req) {
    const principal = req.gatewayPrincipal;
    if (principal?.session.userId) {
        return `user:${principal.session.userId}`;
    }
    if (principal?.session.walletAddress) {
        return `wallet:${principal.session.walletAddress.toLowerCase()}`;
    }
    if (req.serviceAuth?.apiKeyId) {
        return `service:${req.serviceAuth.apiKeyId}`;
    }
    throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Idempotency scope could not resolve actor context');
}
function resolveEndpoint(req) {
    const routePath = typeof req.route?.path === 'string' ? req.route.path : req.path;
    return `${req.baseUrl || ''}${routePath || ''}` || req.path;
}
function normalizeBody(body) {
    if (body === undefined) {
        return null;
    }
    if (Buffer.isBuffer(body)) {
        const asText = body.toString('utf8');
        try {
            return JSON.parse(asText);
        }
        catch {
            return asText;
        }
    }
    if (typeof body === 'string') {
        try {
            return JSON.parse(body);
        }
        catch {
            return body;
        }
    }
    return body;
}
function replayHeaders(res) {
    const headerNames = ['content-type'];
    const snapshot = {};
    for (const name of headerNames) {
        const value = res.getHeader(name);
        if (typeof value === 'string') {
            snapshot[name] = value;
        }
    }
    return snapshot;
}
function createIdempotencyMiddleware(store) {
    return async (req, res, next) => {
        const idempotencyKey = req.header('Idempotency-Key')?.trim();
        if (!idempotencyKey) {
            next(new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required for mutation routes'));
            return;
        }
        const actorId = resolveActorId(req);
        const endpoint = resolveEndpoint(req);
        const requestPath = `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl || req.path;
        const requestFingerprint = (0, idempotencyStore_1.buildRequestFingerprint)(req.method, requestPath, req.rawBody);
        const reservation = await store.createPending({
            idempotencyKey,
            actorId,
            endpoint,
            requestMethod: req.method,
            requestPath,
            requestFingerprint,
            requestId: req.requestContext?.requestId || 'unknown',
        });
        if (!reservation.created) {
            const existing = reservation.record;
            if (existing.requestFingerprint !== requestFingerprint ||
                existing.requestMethod !== req.method ||
                existing.requestPath !== requestPath) {
                next(new errors_1.GatewayError(409, 'CONFLICT', 'Idempotency key is already in use for a different request', {
                    idempotencyKey,
                }));
                return;
            }
            if (existing.completedAt && existing.responseStatus !== null) {
                await store.markReplay({ actorId, endpoint, idempotencyKey });
                res.setHeader('x-idempotent-replay', 'true');
                if (existing.responseHeaders['content-type']) {
                    res.setHeader('content-type', existing.responseHeaders['content-type']);
                }
                res.status(existing.responseStatus).json(existing.responseBody);
                return;
            }
            next(new errors_1.GatewayError(409, 'CONFLICT', 'A request with this idempotency key is already in progress', {
                idempotencyKey,
            }));
            return;
        }
        req.idempotencyState = {
            idempotencyKey,
            actorId,
            endpoint,
            requestFingerprint,
        };
        const originalJson = res.json.bind(res);
        const originalSend = res.send.bind(res);
        let responseBody = null;
        res.json = ((body) => {
            responseBody = body;
            return originalJson(body);
        });
        res.send = ((body) => {
            if (responseBody === null) {
                responseBody = normalizeBody(body);
            }
            return originalSend(body);
        });
        res.on('finish', () => {
            if (res.statusCode >= 500) {
                void store.releasePending({ actorId, endpoint, idempotencyKey });
                return;
            }
            void store.complete({ actorId, endpoint, idempotencyKey }, {
                responseStatus: res.statusCode,
                responseHeaders: replayHeaders(res),
                responseBody,
            });
        });
        next();
    };
}
//# sourceMappingURL=idempotency.js.map