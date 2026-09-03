/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';
import { Pool } from 'pg';

export interface IdempotencyScope {
  actorId: string;
  endpoint: string;
  idempotencyKey: string;
}

export interface IdempotencyRecord extends IdempotencyScope {
  requestMethod: string;
  requestPath: string;
  requestFingerprint: string;
  requestId: string;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown | null;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
}

export interface IdempotencyFinancialOutcome {
  requestId: string;
  transactionHash: string;
  resourceType: 'settlement_handoff' | 'platform_transfer';
  resourceId: string;
  operation: string;
  chainId: number;
  outcomeStatus:
    | 'broadcast_pending'
    | 'broadcast_unknown'
    | 'confirmation_pending'
    | 'confirmed'
    | 'reverted';
}

export interface IdempotencyStore {
  readonly leaseDurationMs: number;
  get(scope: IdempotencyScope): Promise<IdempotencyRecord | null>;
  getFinancialOutcome(requestId: string): Promise<IdempotencyFinancialOutcome | null>;
  createPending(
    entry: IdempotencyScope & {
      requestMethod: string;
      requestPath: string;
      requestFingerprint: string;
      requestId: string;
    },
  ): Promise<{ record: IdempotencyRecord; created: boolean }>;
  complete(
    scope: IdempotencyScope,
    response: {
      responseStatus: number;
      responseHeaders: Record<string, string>;
      responseBody: unknown;
    },
    leaseOwnerRequestId: string,
  ): Promise<void>;
  releasePending(scope: IdempotencyScope, leaseOwnerRequestId: string): Promise<void>;
  renewLease(scope: IdempotencyScope, leaseOwnerRequestId: string): Promise<boolean>;
  markReplay(scope: IdempotencyScope): Promise<void>;
}

interface IdempotencyRow {
  idempotencyKey: string;
  actorId: string;
  endpoint: string;
  requestMethod: string;
  requestPath: string;
  requestFingerprint: string;
  requestId: string;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown | null;
  completedAt: Date | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
}

function mapRow(row: IdempotencyRow): IdempotencyRecord {
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
    leaseExpiresAt: row.leaseExpiresAt ? row.leaseExpiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toScopedKey(scope: IdempotencyScope): string {
  return `${scope.actorId}\u0000${scope.endpoint}\u0000${scope.idempotencyKey}`;
}

export function buildRequestFingerprint(method: string, path: string, rawBody?: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(method.toUpperCase())
    .update('\n')
    .update(path)
    .update('\n')
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');
}

export function createPostgresIdempotencyStore(
  pool: Pool,
  leaseDurationMs = 300_000,
): IdempotencyStore {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new Error('Idempotency lease duration must be an integer of at least 1000ms');
  }

  const get = async (scope: IdempotencyScope): Promise<IdempotencyRecord | null> => {
    const result = await pool.query<IdempotencyRow>(
      `SELECT
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
         lease_expires_at AS "leaseExpiresAt",
         created_at AS "createdAt"
       FROM idempotency_keys
       WHERE actor_id = $1
         AND endpoint = $2
         AND idempotency_key = $3`,
      [scope.actorId, scope.endpoint, scope.idempotencyKey],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  };

  return {
    leaseDurationMs,
    get,

    async getFinancialOutcome(requestId) {
      const result = await pool.query<{
        requestId: string;
        transactionHash: string;
        resourceType: IdempotencyFinancialOutcome['resourceType'];
        resourceId: string;
        operation: string;
        chainId: string;
        outcomeStatus: IdempotencyFinancialOutcome['outcomeStatus'];
      }>(
        `SELECT
           application_request_id AS "requestId",
           transaction_hash AS "transactionHash",
           resource_type AS "resourceType",
           resource_id AS "resourceId",
           operation,
           chain_id AS "chainId",
           outcome_status AS "outcomeStatus"
         FROM gasless_transaction_outcomes
         WHERE application_request_id = $1
         ORDER BY created_at DESC
         LIMIT 2`,
        [requestId],
      );
      if (result.rows.length > 1) {
        throw new Error(`Multiple gasless outcomes found for idempotency request ${requestId}`);
      }
      const row = result.rows[0];
      return row ? { ...row, chainId: Number(row.chainId) } : null;
    },

    async createPending(entry) {
      const insertResult = await pool.query<IdempotencyRow>(
        `INSERT INTO idempotency_keys (
           idempotency_key,
           actor_id,
           endpoint,
           request_method,
           request_path,
           request_fingerprint,
           request_id,
           lease_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8::bigint * INTERVAL '1 millisecond'))
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
           lease_expires_at AS "leaseExpiresAt",
           created_at AS "createdAt"`,
        [
          entry.idempotencyKey,
          entry.actorId,
          entry.endpoint,
          entry.requestMethod,
          entry.requestPath,
          entry.requestFingerprint,
          entry.requestId,
          leaseDurationMs,
        ],
      );

      const createdRow = insertResult.rows[0];
      if (createdRow) {
        return {
          record: mapRow(createdRow),
          created: true,
        };
      }

      const reclaimedResult = await pool.query<IdempotencyRow>(
        `UPDATE idempotency_keys AS idempotency
         SET request_id = $7,
             lease_expires_at = NOW() + ($8::bigint * INTERVAL '1 millisecond'),
             updated_at = NOW()
         WHERE idempotency.actor_id = $1
           AND idempotency.endpoint = $2
           AND idempotency.idempotency_key = $3
           AND idempotency.request_method = $4
           AND idempotency.request_path = $5
           AND idempotency.request_fingerprint = $6
           AND idempotency.completed_at IS NULL
           AND idempotency.lease_expires_at <= NOW()
           AND NOT EXISTS (
             SELECT 1
             FROM gasless_transaction_outcomes AS outcome
             WHERE outcome.application_request_id = idempotency.request_id
           )
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
           lease_expires_at AS "leaseExpiresAt",
           created_at AS "createdAt"`,
        [
          entry.actorId,
          entry.endpoint,
          entry.idempotencyKey,
          entry.requestMethod,
          entry.requestPath,
          entry.requestFingerprint,
          entry.requestId,
          leaseDurationMs,
        ],
      );
      const reclaimedRow = reclaimedResult.rows[0];
      if (reclaimedRow) {
        return { record: mapRow(reclaimedRow), created: true };
      }

      const stored = await get(entry);
      if (!stored) {
        throw new Error(
          `Failed to persist idempotency key ${entry.idempotencyKey} for ${entry.actorId} on ${entry.endpoint}`,
        );
      }

      return {
        record: stored,
        created: false,
      };
    },

    async complete(scope, response, leaseOwnerRequestId) {
      const result = await pool.query(
        `UPDATE idempotency_keys
         SET response_status = $4,
             response_headers = $5::jsonb,
             response_body = $6::jsonb,
             completed_at = NOW(),
             lease_expires_at = NULL,
             updated_at = NOW()
         WHERE actor_id = $1
           AND endpoint = $2
           AND idempotency_key = $3
           AND request_id = $7
           AND completed_at IS NULL`,
        [
          scope.actorId,
          scope.endpoint,
          scope.idempotencyKey,
          response.responseStatus,
          JSON.stringify(response.responseHeaders),
          JSON.stringify(response.responseBody),
          leaseOwnerRequestId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Idempotency lease ownership was lost for ${scope.idempotencyKey}`);
      }
    },

    async releasePending(scope, leaseOwnerRequestId) {
      await pool.query(
        `DELETE FROM idempotency_keys AS idempotency
         WHERE idempotency.actor_id = $1
           AND idempotency.endpoint = $2
           AND idempotency.idempotency_key = $3
           AND idempotency.request_id = $4
           AND idempotency.completed_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM gasless_transaction_outcomes AS outcome
             WHERE outcome.application_request_id = idempotency.request_id
           )`,
        [scope.actorId, scope.endpoint, scope.idempotencyKey, leaseOwnerRequestId],
      );
    },

    async renewLease(scope, leaseOwnerRequestId) {
      const result = await pool.query(
        `UPDATE idempotency_keys
         SET lease_expires_at = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
             updated_at = NOW()
         WHERE actor_id = $1
           AND endpoint = $2
           AND idempotency_key = $3
           AND request_id = $4
           AND completed_at IS NULL`,
        [scope.actorId, scope.endpoint, scope.idempotencyKey, leaseOwnerRequestId, leaseDurationMs],
      );
      return result.rowCount === 1;
    },

    async markReplay(scope) {
      await pool.query(
        `UPDATE idempotency_keys
         SET last_replayed_at = NOW(), updated_at = NOW()
         WHERE actor_id = $1
           AND endpoint = $2
           AND idempotency_key = $3`,
        [scope.actorId, scope.endpoint, scope.idempotencyKey],
      );
    },
  };
}

export function createInMemoryIdempotencyStore(leaseDurationMs = 300_000): IdempotencyStore {
  const store = new Map<string, IdempotencyRecord>();

  return {
    leaseDurationMs,
    async get(scope) {
      return store.get(toScopedKey(scope)) ?? null;
    },

    async getFinancialOutcome() {
      return null;
    },

    async createPending(entry) {
      const scopedKey = toScopedKey(entry);
      const existing = store.get(scopedKey);
      if (existing) {
        if (
          !existing.completedAt &&
          existing.leaseExpiresAt &&
          Date.parse(existing.leaseExpiresAt) <= Date.now() &&
          existing.requestMethod === entry.requestMethod &&
          existing.requestPath === entry.requestPath &&
          existing.requestFingerprint === entry.requestFingerprint
        ) {
          const reclaimed = {
            ...existing,
            requestId: entry.requestId,
            leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
          };
          store.set(scopedKey, reclaimed);
          return { record: reclaimed, created: true };
        }
        return {
          record: existing,
          created: false,
        };
      }

      const record: IdempotencyRecord = {
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
        leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
        createdAt: new Date().toISOString(),
      };

      store.set(scopedKey, record);
      return {
        record,
        created: true,
      };
    },

    async complete(scope, response, leaseOwnerRequestId) {
      const scopedKey = toScopedKey(scope);
      const existing = store.get(scopedKey);
      if (!existing) {
        throw new Error(`Missing in-memory idempotency record for ${scope.idempotencyKey}`);
      }
      if (existing.requestId !== leaseOwnerRequestId || existing.completedAt) {
        throw new Error(`Idempotency lease ownership was lost for ${scope.idempotencyKey}`);
      }

      store.set(scopedKey, {
        ...existing,
        responseStatus: response.responseStatus,
        responseHeaders: response.responseHeaders,
        responseBody: response.responseBody,
        completedAt: new Date().toISOString(),
        leaseExpiresAt: null,
      });
    },

    async releasePending(scope, leaseOwnerRequestId) {
      const scopedKey = toScopedKey(scope);
      const existing = store.get(scopedKey);
      if (!existing || existing.completedAt || existing.requestId !== leaseOwnerRequestId) {
        return;
      }

      store.delete(scopedKey);
    },

    async renewLease(scope, leaseOwnerRequestId) {
      const scopedKey = toScopedKey(scope);
      const existing = store.get(scopedKey);
      if (!existing || existing.completedAt || existing.requestId !== leaseOwnerRequestId) {
        return false;
      }
      store.set(scopedKey, {
        ...existing,
        leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
      });
      return true;
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
