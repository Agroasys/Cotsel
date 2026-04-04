"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPostgresAuditLogStore = createPostgresAuditLogStore;
exports.createInMemoryAuditLogStore = createInMemoryAuditLogStore;
function createPostgresAuditLogStore(pool) {
    return {
        async append(entry) {
            await pool.query(`INSERT INTO audit_log (
           event_type,
           route,
           method,
           request_id,
           correlation_id,
           action_id,
           idempotency_key,
           actor_id,
           actor_user_id,
           actor_wallet_address,
           actor_role,
           status,
           metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`, [
                entry.eventType,
                entry.route,
                entry.method,
                entry.requestId,
                entry.correlationId || null,
                entry.actionId || null,
                entry.idempotencyKey || null,
                entry.actorId || null,
                entry.actorUserId || null,
                entry.actorWalletAddress || null,
                entry.actorRole || null,
                entry.status,
                JSON.stringify(entry.metadata || {}),
            ]);
        },
    };
}
function createInMemoryAuditLogStore(entries = []) {
    return {
        entries,
        async append(entry) {
            entries.push({
                ...entry,
                metadata: entry.metadata ? { ...entry.metadata } : undefined,
            });
        },
    };
}
//# sourceMappingURL=auditLogStore.js.map