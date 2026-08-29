/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import type { SettlementCallbackDeliveryRecord, SettlementStore } from './settlementStoreTypes';

export interface SettlementCallbackDeliveryRow {
  deliveryId: string;
  handoffId: string;
  eventId: string;
  targetUrl: string;
  requestBody: Record<string, unknown>;
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead_letter' | 'disabled';
  attemptCount: number;
  nextAttemptAt: Date;
  lastAttemptedAt: Date | null;
  deliveredAt: Date | null;
  responseStatus: number | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  requestId: string;
  createdAt: Date;
  updatedAt: Date;
}

export function mapSettlementCallbackDeliveryRow(
  row: SettlementCallbackDeliveryRow,
): SettlementCallbackDeliveryRecord {
  return {
    deliveryId: row.deliveryId,
    handoffId: row.handoffId,
    eventId: row.eventId,
    targetUrl: row.targetUrl,
    requestBody: row.requestBody || {},
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastAttemptedAt: row.lastAttemptedAt ? row.lastAttemptedAt.toISOString() : null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt ? row.leaseExpiresAt.toISOString() : null,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type SettlementCallbackStore = Pick<
  SettlementStore,
  | 'getCallbackDelivery'
  | 'getDueCallbackDeliveries'
  | 'markCallbackDelivering'
  | 'markCallbackDelivered'
  | 'markCallbackFailed'
  | 'requeueCallbackDelivery'
>;

const deliveryProjection = `
  delivery_id AS "deliveryId",
  handoff_id AS "handoffId",
  event_id AS "eventId",
  target_url AS "targetUrl",
  request_body AS "requestBody",
  status,
  attempt_count AS "attemptCount",
  next_attempt_at AS "nextAttemptAt",
  last_attempted_at AS "lastAttemptedAt",
  delivered_at AS "deliveredAt",
  response_status AS "responseStatus",
  last_error AS "lastError",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  request_id AS "requestId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export function createPostgresSettlementCallbackStore(pool: Pool): SettlementCallbackStore {
  return {
    async getDueCallbackDeliveries(limit, now) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `SELECT ${deliveryProjection}
         FROM settlement_callback_deliveries
         WHERE (
             status IN ('pending', 'failed')
             AND next_attempt_at <= $1
           ) OR (
             status = 'delivering'
             AND lease_expires_at <= $1
           )
         ORDER BY COALESCE(lease_expires_at, next_attempt_at) ASC, created_at ASC
         LIMIT $2`,
        [now, limit],
      );

      return result.rows.map(mapSettlementCallbackDeliveryRow);
    },

    async getCallbackDelivery(deliveryId) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `SELECT ${deliveryProjection}
         FROM settlement_callback_deliveries
         WHERE delivery_id = $1`,
        [deliveryId],
      );

      return result.rows[0] ? mapSettlementCallbackDeliveryRow(result.rows[0]) : null;
    },

    async markCallbackDelivering(deliveryId, leaseOwner, attemptedAt, leaseExpiresAt) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `UPDATE settlement_callback_deliveries
         SET status = 'delivering',
             attempt_count = attempt_count + 1,
             last_attempted_at = $3,
             lease_owner = $2,
             lease_expires_at = $4,
             updated_at = NOW()
         WHERE delivery_id = $1
           AND (
             (status IN ('pending', 'failed') AND next_attempt_at <= $3)
             OR (status = 'delivering' AND lease_expires_at <= $3)
           )
         RETURNING ${deliveryProjection}`,
        [deliveryId, leaseOwner, attemptedAt, leaseExpiresAt],
      );

      return result.rows[0] ? mapSettlementCallbackDeliveryRow(result.rows[0]) : null;
    },

    async markCallbackDelivered(deliveryId, leaseOwner, completedAt, responseStatus) {
      const result = await pool.query<{ updated: boolean }>(
        `WITH delivered AS (
           UPDATE settlement_callback_deliveries
           SET status = 'delivered',
               response_status = $4,
               delivered_at = $3,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE delivery_id = $1
             AND status = 'delivering'
             AND lease_owner = $2
           RETURNING handoff_id, event_id
         ), updated_handoff AS (
           UPDATE settlement_handoffs handoffs
           SET callback_status = 'delivered',
               callback_delivered_at = $3,
               updated_at = NOW()
           FROM delivered
           WHERE handoffs.handoff_id = delivered.handoff_id
             AND handoffs.latest_event_id = delivered.event_id
           RETURNING handoffs.handoff_id
         )
         SELECT EXISTS(SELECT 1 FROM delivered) AS updated`,
        [deliveryId, leaseOwner, completedAt, responseStatus],
      );
      return result.rows[0]?.updated === true;
    },

    async markCallbackFailed(deliveryId, leaseOwner, update) {
      const result = await pool.query<{ updated: boolean }>(
        `WITH failed AS (
           UPDATE settlement_callback_deliveries
           SET status = CASE WHEN $6 THEN 'dead_letter' ELSE 'failed' END,
               response_status = $4,
               last_error = $5,
               last_attempted_at = $3,
               next_attempt_at = $7,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE delivery_id = $1
             AND status = 'delivering'
             AND lease_owner = $2
           RETURNING handoff_id, event_id
         ), updated_handoff AS (
           UPDATE settlement_handoffs handoffs
           SET callback_status = CASE WHEN $6 THEN 'dead_letter' ELSE 'failed' END,
               updated_at = NOW()
           FROM failed
           WHERE handoffs.handoff_id = failed.handoff_id
             AND handoffs.latest_event_id = failed.event_id
           RETURNING handoffs.handoff_id
         )
         SELECT EXISTS(SELECT 1 FROM failed) AS updated`,
        [
          deliveryId,
          leaseOwner,
          update.attemptedAt,
          update.responseStatus ?? null,
          update.errorMessage,
          update.deadLetter,
          update.nextAttemptAt,
        ],
      );
      return result.rows[0]?.updated === true;
    },

    async requeueCallbackDelivery(deliveryId, nextAttemptAt) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `UPDATE settlement_callback_deliveries
         SET status = 'pending',
             next_attempt_at = $2,
             lease_owner = NULL,
             lease_expires_at = NULL,
             updated_at = NOW()
         WHERE delivery_id = $1
           AND status = 'dead_letter'
         RETURNING ${deliveryProjection}`,
        [deliveryId, nextAttemptAt],
      );

      return result.rows[0] ? mapSettlementCallbackDeliveryRow(result.rows[0]) : null;
    },
  };
}
