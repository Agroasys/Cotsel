"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeAuditFeedCursor = encodeAuditFeedCursor;
exports.decodeAuditFeedCursor = decodeAuditFeedCursor;
exports.createPostgresAuditFeedStore = createPostgresAuditFeedStore;
exports.createInMemoryAuditFeedStore = createInMemoryAuditFeedStore;
function cloneEvent(event) {
    return {
        ...event,
        actor: { ...event.actor },
        metadata: { ...event.metadata },
    };
}
function mapRow(row) {
    return {
        eventId: String(row.eventId),
        eventType: row.eventType,
        route: row.route,
        method: row.method,
        requestId: row.requestId,
        correlationId: row.correlationId,
        actor: {
            userId: row.actorUserId,
            walletAddress: row.actorWalletAddress,
            role: row.actorRole,
        },
        status: row.status,
        metadata: { ...(row.metadata ?? {}) },
        source: 'audit_log',
        createdAt: row.createdAt.toISOString(),
    };
}
function encodeAuditFeedCursor(cursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
function decodeAuditFeedCursor(cursor) {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed.createdAt || !parsed.eventId) {
        throw new Error('Cursor is missing required fields');
    }
    if (Number.isNaN(Date.parse(parsed.createdAt))) {
        throw new Error('Cursor createdAt must be an ISO timestamp');
    }
    return parsed;
}
function nextCursorFromItems(items, limit) {
    if (items.length <= limit) {
        return null;
    }
    const boundary = items[limit - 1];
    return encodeAuditFeedCursor({
        createdAt: boundary.createdAt,
        eventId: boundary.eventId,
    });
}
function compareEventIds(left, right) {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) {
        return 0;
    }
    return leftId < rightId ? -1 : 1;
}
function createPostgresAuditFeedStore(pool) {
    const selectColumns = `SELECT
    id AS "eventId",
    event_type AS "eventType",
    route,
    method,
    request_id AS "requestId",
    correlation_id AS "correlationId",
    actor_user_id AS "actorUserId",
    actor_wallet_address AS "actorWalletAddress",
    actor_role AS "actorRole",
    status,
    metadata,
    created_at AS "createdAt"`;
    return {
        async list(input) {
            const values = [];
            const conditions = [];
            if (input.eventType) {
                values.push(input.eventType);
                conditions.push(`event_type = $${values.length}`);
            }
            if (input.actorUserId) {
                values.push(input.actorUserId);
                conditions.push(`actor_user_id = $${values.length}`);
            }
            if (input.cursor) {
                const cursor = decodeAuditFeedCursor(input.cursor);
                values.push(cursor.createdAt);
                const createdAtIndex = values.length;
                values.push(cursor.eventId);
                const eventIdIndex = values.length;
                conditions.push(`(created_at < $${createdAtIndex}::timestamp OR (created_at = $${createdAtIndex}::timestamp AND id < $${eventIdIndex}::bigint))`);
            }
            values.push(input.limit + 1);
            const limitIndex = values.length;
            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const result = await pool.query(`${selectColumns}
         FROM audit_log
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT $${limitIndex}`, values);
            const mapped = result.rows.map(mapRow);
            return {
                items: mapped.slice(0, input.limit),
                nextCursor: nextCursorFromItems(mapped, input.limit),
            };
        },
    };
}
function createInMemoryAuditFeedStore(initial = []) {
    const items = initial.map(cloneEvent);
    function sorted() {
        return [...items].sort((left, right) => {
            if (left.createdAt === right.createdAt) {
                return compareEventIds(right.eventId, left.eventId);
            }
            return right.createdAt.localeCompare(left.createdAt);
        });
    }
    return {
        async list(input) {
            let candidates = sorted();
            if (input.eventType) {
                candidates = candidates.filter((event) => event.eventType === input.eventType);
            }
            if (input.actorUserId) {
                candidates = candidates.filter((event) => event.actor.userId === input.actorUserId);
            }
            if (input.cursor) {
                const cursor = decodeAuditFeedCursor(input.cursor);
                candidates = candidates.filter((event) => (event.createdAt < cursor.createdAt
                    || (event.createdAt === cursor.createdAt && compareEventIds(event.eventId, cursor.eventId) < 0)));
            }
            const page = candidates.slice(0, input.limit + 1);
            return {
                items: page.slice(0, input.limit).map(cloneEvent),
                nextCursor: nextCursorFromItems(page, input.limit),
            };
        },
    };
}
//# sourceMappingURL=auditFeedStore.js.map