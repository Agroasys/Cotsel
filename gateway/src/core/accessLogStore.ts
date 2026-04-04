/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';

export const ACCESS_AUDIT_REFERENCE_TYPES = [
  'audit_log',
  'governance_action',
  'compliance_decision',
  'settlement_handoff',
  'external',
] as const;

export type AccessAuditReferenceType = typeof ACCESS_AUDIT_REFERENCE_TYPES[number];

export interface AccessAuditReference {
  type: AccessAuditReferenceType;
  reference: string;
}

export interface AccessLogActor {
  userId: string;
  walletAddress: string | null;
  role: string;
  sessionFingerprint: string;
  sessionDisplay: string;
}

export interface AccessLogNetwork {
  ipFingerprint: string | null;
  ipDisplay: string | null;
  userAgent: string | null;
}

export interface AccessLogRequest {
  requestId: string;
  correlationId: string | null;
  method: string;
  route: string;
}

export interface AccessLogEntry {
  entryId: string;
  eventType: string;
  surface: string;
  outcome: string;
  actor: AccessLogActor;
  network: AccessLogNetwork;
  request: AccessLogRequest;
  auditReferences: AccessAuditReference[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AccessLogCursor {
  createdAt: string;
  entryId: string;
}

export interface ListAccessLogInput {
  eventType?: string;
  outcome?: string;
  actorUserId?: string;
  limit: number;
  cursor?: string;
}

export interface ListAccessLogResult {
  items: AccessLogEntry[];
  nextCursor: string | null;
}

export interface AccessLogStore {
  append(entry: AccessLogEntry): Promise<AccessLogEntry>;
  get(entryId: string): Promise<AccessLogEntry | null>;
  list(input: ListAccessLogInput): Promise<ListAccessLogResult>;
}

interface AccessLogRow {
  entryId: string;
  eventType: string;
  surface: string;
  outcome: string;
  actorUserId: string;
  actorWalletAddress: string | null;
  actorRole: string;
  sessionFingerprint: string;
  sessionDisplay: string;
  ipFingerprint: string | null;
  ipDisplay: string | null;
  userAgent: string | null;
  requestId: string;
  correlationId: string | null;
  requestMethod: string;
  requestRoute: string;
  auditReferences: AccessAuditReference[];
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function cloneAuditReferences(references: AccessAuditReference[]): AccessAuditReference[] {
  return references.map((reference) => ({ ...reference }));
}

function cloneEntry(entry: AccessLogEntry): AccessLogEntry {
  return {
    ...entry,
    actor: { ...entry.actor },
    network: { ...entry.network },
    request: { ...entry.request },
    auditReferences: cloneAuditReferences(entry.auditReferences),
    metadata: { ...entry.metadata },
  };
}

function mapRow(row: AccessLogRow): AccessLogEntry {
  return {
    entryId: row.entryId,
    eventType: row.eventType,
    surface: row.surface,
    outcome: row.outcome,
    actor: {
      userId: row.actorUserId,
      walletAddress: row.actorWalletAddress,
      role: row.actorRole,
      sessionFingerprint: row.sessionFingerprint,
      sessionDisplay: row.sessionDisplay,
    },
    network: {
      ipFingerprint: row.ipFingerprint,
      ipDisplay: row.ipDisplay,
      userAgent: row.userAgent,
    },
    request: {
      requestId: row.requestId,
      correlationId: row.correlationId,
      method: row.requestMethod,
      route: row.requestRoute,
    },
    auditReferences: cloneAuditReferences(row.auditReferences ?? []),
    metadata: { ...(row.metadata ?? {}) },
    createdAt: row.createdAt.toISOString(),
  };
}

export function encodeAccessLogCursor(cursor: AccessLogCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeAccessLogCursor(cursor: string): AccessLogCursor {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as AccessLogCursor;
  if (!parsed.createdAt || !parsed.entryId) {
    throw new Error('Cursor is missing required fields');
  }

  if (Number.isNaN(Date.parse(parsed.createdAt))) {
    throw new Error('Cursor createdAt must be an ISO timestamp');
  }

  return parsed;
}

function nextCursorFromItems(items: AccessLogEntry[], limit: number): string | null {
  if (items.length <= limit) {
    return null;
  }

  const boundary = items[limit - 1];
  return encodeAccessLogCursor({
    createdAt: boundary.createdAt,
    entryId: boundary.entryId,
  });
}

export function createPostgresAccessLogStore(pool: Pool): AccessLogStore {
  const selectColumns = `SELECT
    entry_id AS "entryId",
    event_type AS "eventType",
    surface,
    outcome,
    actor_user_id AS "actorUserId",
    actor_wallet_address AS "actorWalletAddress",
    actor_role AS "actorRole",
    session_fingerprint AS "sessionFingerprint",
    session_display AS "sessionDisplay",
    ip_fingerprint AS "ipFingerprint",
    ip_display AS "ipDisplay",
    user_agent AS "userAgent",
    request_id AS "requestId",
    correlation_id AS "correlationId",
    request_method AS "requestMethod",
    request_route AS "requestRoute",
    audit_references AS "auditReferences",
    metadata,
    created_at AS "createdAt"`;

  return {
    async append(entry) {
      await pool.query(
        `INSERT INTO access_log_entries (
          entry_id,
          event_type,
          surface,
          outcome,
          actor_user_id,
          actor_wallet_address,
          actor_role,
          session_fingerprint,
          session_display,
          ip_fingerprint,
          ip_display,
          user_agent,
          request_id,
          correlation_id,
          request_method,
          request_route,
          audit_references,
          metadata,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19
        )`,
        [
          entry.entryId,
          entry.eventType,
          entry.surface,
          entry.outcome,
          entry.actor.userId,
          entry.actor.walletAddress,
          entry.actor.role,
          entry.actor.sessionFingerprint,
          entry.actor.sessionDisplay,
          entry.network.ipFingerprint,
          entry.network.ipDisplay,
          entry.network.userAgent,
          entry.request.requestId,
          entry.request.correlationId,
          entry.request.method,
          entry.request.route,
          JSON.stringify(entry.auditReferences),
          JSON.stringify(entry.metadata),
          entry.createdAt,
        ],
      );

      const stored = await this.get(entry.entryId);
      if (!stored) {
        throw new Error(`Failed to persist access log entry ${entry.entryId}`);
      }

      return stored;
    },

    async get(entryId) {
      const result = await pool.query<AccessLogRow>(
        `${selectColumns}
         FROM access_log_entries
         WHERE entry_id = $1`,
        [entryId],
      );

      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async list(input) {
      const values: unknown[] = [];
      const conditions: string[] = [];

      if (input.eventType) {
        values.push(input.eventType);
        conditions.push(`event_type = $${values.length}`);
      }

      if (input.outcome) {
        values.push(input.outcome);
        conditions.push(`outcome = $${values.length}`);
      }

      if (input.actorUserId) {
        values.push(input.actorUserId);
        conditions.push(`actor_user_id = $${values.length}`);
      }

      if (input.cursor) {
        const cursor = decodeAccessLogCursor(input.cursor);
        values.push(cursor.createdAt);
        const createdAtIndex = values.length;
        values.push(cursor.entryId);
        const entryIdIndex = values.length;
        conditions.push(`(created_at < $${createdAtIndex}::timestamp OR (created_at = $${createdAtIndex}::timestamp AND entry_id < $${entryIdIndex}))`);
      }

      values.push(input.limit + 1);
      const limitIndex = values.length;

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await pool.query<AccessLogRow>(
        `${selectColumns}
         FROM access_log_entries
         ${whereClause}
         ORDER BY created_at DESC, entry_id DESC
         LIMIT $${limitIndex}`,
        values,
      );

      const mapped = result.rows.map(mapRow);
      return {
        items: mapped.slice(0, input.limit),
        nextCursor: nextCursorFromItems(mapped, input.limit),
      };
    },
  };
}

export function createInMemoryAccessLogStore(initial: AccessLogEntry[] = []): AccessLogStore {
  const items = new Map<string, AccessLogEntry>(initial.map((entry) => [entry.entryId, cloneEntry(entry)]));

  function sorted(): AccessLogEntry[] {
    return [...items.values()].sort((left, right) => {
      if (left.createdAt === right.createdAt) {
        return right.entryId.localeCompare(left.entryId);
      }

      return right.createdAt.localeCompare(left.createdAt);
    });
  }

  return {
    async append(entry) {
      items.set(entry.entryId, cloneEntry(entry));
      return (await this.get(entry.entryId))!;
    },

    async get(entryId) {
      const entry = items.get(entryId);
      return entry ? cloneEntry(entry) : null;
    },

    async list(input) {
      let candidates = sorted();

      if (input.eventType) {
        candidates = candidates.filter((entry) => entry.eventType === input.eventType);
      }

      if (input.outcome) {
        candidates = candidates.filter((entry) => entry.outcome === input.outcome);
      }

      if (input.actorUserId) {
        candidates = candidates.filter((entry) => entry.actor.userId === input.actorUserId);
      }

      if (input.cursor) {
        const cursor = decodeAccessLogCursor(input.cursor);
        candidates = candidates.filter((entry) => (
          entry.createdAt < cursor.createdAt
          || (entry.createdAt === cursor.createdAt && entry.entryId < cursor.entryId)
        ));
      }

      const page = candidates.slice(0, input.limit + 1);
      return {
        items: page.slice(0, input.limit).map(cloneEntry),
        nextCursor: nextCursorFromItems(page, input.limit),
      };
    },
  };
}
