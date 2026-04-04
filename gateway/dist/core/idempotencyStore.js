"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRequestFingerprint = buildRequestFingerprint;
exports.createPostgresIdempotencyStore = createPostgresIdempotencyStore;
exports.createInMemoryIdempotencyStore = createInMemoryIdempotencyStore;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = __importDefault(require("crypto"));
function mapRow(row) {
    return {
        idempotencyKey: row.idempotencyKey,
        actorId: row.actorId,
        endpoint: row.endpoint,
        requestMethod: row.requestMethod,
        requestPath: row.requestPath,
        requestFingerprint: row.requestFingerprint,
        requestId: row.requestId,
        responseStatus: row.responseStatus,
        responseHeaders: row.responseHeaders || {},
        responseBody: row.responseBody,
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
    };
}
function toScopedKey(scope) {
    return `${scope.actorId}\u0000${scope.endpoint}\u0000${scope.idempotencyKey}`;
}
function buildRequestFingerprint(method, path, rawBody) {
    return crypto_1.default
        .createHash('sha256')
        .update(method.toUpperCase())
        .update('\n')
        .update(path)
        .update('\n')
        .update(rawBody || Buffer.alloc(0))
        .digest('hex');
}
function createPostgresIdempotencyStore(pool) {
    const get = async (scope) => {
        const result = await pool.query(`SELECT
         idempotency_key AS "idempotencyKey",
         actor_id AS "actorId",
         endpoint AS "endpoint",
         request_method AS "requestMethod",
         request_path AS "requestPath",
         request_fingerprint AS "requestFingerprint",
         request_id AS "requestId",
         response_status AS "responseStatus",
         response_headers AS "responseHeaders",
         response_body AS "responseBody",
         completed_at AS "completedAt",
         created_at AS "createdAt"
       FROM idempotency_keys
       WHERE actor_id = $1
         AND endpoint = $2
         AND idempotency_key = $3`, [scope.actorId, scope.endpoint, scope.idempotencyKey]);
        return result.rows[0] ? mapRow(result.rows[0]) : null;
    };
    return {
        get,
        async createPending(entry) {
            const insertResult = await pool.query(`INSERT INTO idempotency_keys (
           idempotency_key,
           actor_id,
           endpoint,
           request_method,
           request_path,
           request_fingerprint,
           request_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (actor_id, endpoint, idempotency_key) DO NOTHING
         RETURNING
           idempotency_key AS "idempotencyKey",
           actor_id AS "actorId",
           endpoint AS "endpoint",
           request_method AS "requestMethod",
           request_path AS "requestPath",
           request_fingerprint AS "requestFingerprint",
           request_id AS "requestId",
           response_status AS "responseStatus",
           response_headers AS "responseHeaders",
           response_body AS "responseBody",
           completed_at AS "completedAt",
           created_at AS "createdAt"`, [
                entry.idempotencyKey,
                entry.actorId,
                entry.endpoint,
                entry.requestMethod,
                entry.requestPath,
                entry.requestFingerprint,
                entry.requestId,
            ]);
            const createdRow = insertResult.rows[0];
            if (createdRow) {
                return {
                    record: mapRow(createdRow),
                    created: true,
                };
            }
            const stored = await get(entry);
            if (!stored) {
                throw new Error(`Failed to persist idempotency key ${entry.idempotencyKey} for ${entry.actorId} on ${entry.endpoint}`);
            }
            return {
                record: stored,
                created: false,
            };
        },
        async complete(scope, response) {
            await pool.query(`UPDATE idempotency_keys
         SET response_status = $4,
             response_headers = $5::jsonb,
             response_body = $6::jsonb,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE actor_id = $1
           AND endpoint = $2
           AND idempotency_key = $3`, [
                scope.actorId,
                scope.endpoint,
                scope.idempotencyKey,
                response.responseStatus,
                JSON.stringify(response.responseHeaders),
                JSON.stringify(response.responseBody),
            ]);
        },
        async releasePending(scope) {
            await pool.query(`DELETE FROM idempotency_keys
         WHERE actor_id = $1
           AND endpoint = $2
           AND idempotency_key = $3
           AND completed_at IS NULL`, [scope.actorId, scope.endpoint, scope.idempotencyKey]);
        },
        async markReplay(scope) {
            await pool.query(`UPDATE idempotency_keys
         SET last_replayed_at = NOW(), updated_at = NOW()
         WHERE actor_id = $1
           AND endpoint = $2
           AND idempotency_key = $3`, [scope.actorId, scope.endpoint, scope.idempotencyKey]);
        },
    };
}
function createInMemoryIdempotencyStore() {
    const store = new Map();
    return {
        async get(scope) {
            return store.get(toScopedKey(scope)) ?? null;
        },
        async createPending(entry) {
            const scopedKey = toScopedKey(entry);
            const existing = store.get(scopedKey);
            if (existing) {
                return {
                    record: existing,
                    created: false,
                };
            }
            const record = {
                idempotencyKey: entry.idempotencyKey,
                actorId: entry.actorId,
                endpoint: entry.endpoint,
                requestMethod: entry.requestMethod,
                requestPath: entry.requestPath,
                requestFingerprint: entry.requestFingerprint,
                requestId: entry.requestId,
                responseStatus: null,
                responseHeaders: {},
                responseBody: null,
                completedAt: null,
                createdAt: new Date().toISOString(),
            };
            store.set(scopedKey, record);
            return {
                record,
                created: true,
            };
        },
        async complete(scope, response) {
            const scopedKey = toScopedKey(scope);
            const existing = store.get(scopedKey);
            if (!existing) {
                throw new Error(`Missing in-memory idempotency record for ${scope.idempotencyKey}`);
            }
            store.set(scopedKey, {
                ...existing,
                responseStatus: response.responseStatus,
                responseHeaders: response.responseHeaders,
                responseBody: response.responseBody,
                completedAt: new Date().toISOString(),
            });
        },
        async releasePending(scope) {
            const scopedKey = toScopedKey(scope);
            const existing = store.get(scopedKey);
            if (!existing || existing.completedAt) {
                return;
            }
            store.delete(scopedKey);
        },
        async markReplay(scope) {
            const scopedKey = toScopedKey(scope);
            const existing = store.get(scopedKey);
            if (!existing) {
                return;
            }
            store.set(scopedKey, existing);
        },
    };
}
//# sourceMappingURL=idempotencyStore.js.map