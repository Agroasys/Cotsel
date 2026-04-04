"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const SERVICE_NAME = 'gateway';
const REDACT_KEYS = new Set([
    'authorization',
    'token',
    'accessToken',
    'refreshToken',
    'apiKey',
    'secret',
    'password',
    'hmacSecret',
]);
function redactValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
            if (REDACT_KEYS.has(key)) {
                return [key, '[REDACTED]'];
            }
            return [key, redactValue(entry)];
        }));
    }
    return value;
}
function baseContext(meta) {
    return redactValue({
        service: SERVICE_NAME,
        env: process.env.NODE_ENV || 'development',
        requestId: meta?.requestId ?? null,
        correlationId: meta?.correlationId ?? null,
        userId: meta?.userId ?? null,
        walletAddress: meta?.walletAddress ?? null,
        gatewayRoles: meta?.gatewayRoles ?? null,
        route: meta?.route ?? null,
        method: meta?.method ?? null,
        statusCode: meta?.statusCode ?? null,
        durationMs: meta?.durationMs ?? null,
        ...meta,
    });
}
function normalizeMeta(metaOrError) {
    if (!metaOrError)
        return undefined;
    if (metaOrError instanceof Error) {
        return { error: metaOrError.message, stack: metaOrError.stack };
    }
    if (typeof metaOrError === 'object') {
        return metaOrError;
    }
    return { error: String(metaOrError) };
}
class Logger {
    static write(level, message, meta) {
        const payload = {
            level,
            timestamp: new Date().toISOString(),
            message,
            ...baseContext(meta),
        };
        if (level === 'error') {
            console.error(JSON.stringify(payload));
            return;
        }
        if (level === 'warn') {
            console.warn(JSON.stringify(payload));
            return;
        }
        if (level === 'debug') {
            if (process.env.NODE_ENV === 'development') {
                console.debug(JSON.stringify(payload));
            }
            return;
        }
        console.log(JSON.stringify(payload));
    }
    static info(message, meta) {
        this.write('info', message, meta);
    }
    static warn(message, meta) {
        this.write('warn', message, meta);
    }
    static error(message, metaOrError) {
        this.write('error', message, normalizeMeta(metaOrError));
    }
    static debug(message, meta) {
        this.write('debug', message, meta);
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map