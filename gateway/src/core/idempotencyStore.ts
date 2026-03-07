/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';
import { Pool } from 'pg';

export interface IdempotencyRecord {
  idempotencyKey: string;
  requestMethod: string;
  requestPath: string;
  requestFingerprint: string;
  requestId: string;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown | null;
  completedAt: string | null;
  createdAt: string;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  createPending(entry: {
    idempotencyKey: string;
    requestMethod: string;
    requestPath: string;
    requestFingerprint: string;
    requestId: string;
  }): Promise<IdempotencyRecord>;
  complete(key: string, response: {
    responseStatus: number;
    responseHeaders: Record<string, string>;
    responseBody: unknown;
  }): Promise<void>;
  markReplay(key: string): Promise<void>;
}

interface IdempotencyRow {
  idempotencyKey: string;
  requestMethod: string;
  requestPath: string;
  requestFingerprint: string;
  requestId: string;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown | null;
  completedAt: Date | null;
  createdAt: Date;
}

function mapRow(row: IdempotencyRow): IdempotencyRecord {
  return {
    idempotencyKey: row.idempotencyKey,
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

export function createPostgresIdempotencyStore(pool: Pool): IdempotencyStore {
  const get = async (key: string): Promise<IdempotencyRecord | null> => {
    const result = await pool.query<IdempotencyRow>(
      `SELECT
         idempotency_key AS "idempotencyKey",
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
       WHERE idempotency_key = $1`,
      [key],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  };

  return {
    get,

    async createPending(entry) {
      await pool.query(
        `INSERT INTO idempotency_keys (
           idempotency_key,
           request_method,
           request_path,
           request_fingerprint,
           request_id
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          entry.idempotencyKey,
          entry.requestMethod,
          entry.requestPath,
          entry.requestFingerprint,
          entry.requestId,
        ],
      );

      const stored = await get(entry.idempotencyKey);
      if (!stored) {
        throw new Error(`Failed to persist idempotency key ${entry.idempotencyKey}`);
      }

      return stored;
    },

    async complete(key, response) {
      await pool.query(
        `UPDATE idempotency_keys
         SET response_status = $2,
             response_headers = $3::jsonb,
             response_body = $4::jsonb,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE idempotency_key = $1`,
        [key, response.responseStatus, JSON.stringify(response.responseHeaders), JSON.stringify(response.responseBody)],
      );
    },

    async markReplay(key) {
      await pool.query(
        `UPDATE idempotency_keys
         SET last_replayed_at = NOW(), updated_at = NOW()
         WHERE idempotency_key = $1`,
        [key],
      );
    },
  };
}

export function createInMemoryIdempotencyStore(): IdempotencyStore {
  const store = new Map<string, IdempotencyRecord>();

  return {
    async get(key) {
      return store.get(key) ?? null;
    },

    async createPending(entry) {
      const existing = store.get(entry.idempotencyKey);
      if (existing) {
        return existing;
      }

      const record: IdempotencyRecord = {
        idempotencyKey: entry.idempotencyKey,
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

      store.set(entry.idempotencyKey, record);
      return record;
    },

    async complete(key, response) {
      const existing = store.get(key);
      if (!existing) {
        throw new Error(`Missing in-memory idempotency record for ${key}`);
      }

      store.set(key, {
        ...existing,
        responseStatus: response.responseStatus,
        responseHeaders: response.responseHeaders,
        responseBody: response.responseBody,
        completedAt: new Date().toISOString(),
      });
    },

    async markReplay(key) {
      const existing = store.get(key);
      if (!existing) {
        return;
      }

      store.set(key, existing);
    },
  };
}
