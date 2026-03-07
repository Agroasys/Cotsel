/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';

export interface AuditLogEntry {
  eventType: string;
  route: string;
  method: string;
  requestId: string;
  correlationId?: string | null;
  actorUserId?: string | null;
  actorWalletAddress?: string | null;
  actorRole?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogStore {
  append(entry: AuditLogEntry): Promise<void>;
}

export function createPostgresAuditLogStore(pool: Pool): AuditLogStore {
  return {
    async append(entry) {
      await pool.query(
        `INSERT INTO audit_log (
           event_type,
           route,
           method,
           request_id,
           correlation_id,
           actor_user_id,
           actor_wallet_address,
           actor_role,
           status,
           metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          entry.eventType,
          entry.route,
          entry.method,
          entry.requestId,
          entry.correlationId || null,
          entry.actorUserId || null,
          entry.actorWalletAddress || null,
          entry.actorRole || null,
          entry.status,
          JSON.stringify(entry.metadata || {}),
        ],
      );
    },
  };
}
