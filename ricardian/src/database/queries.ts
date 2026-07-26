import { pool } from './connection';
import { RicardianHashRow } from '../types';
import { createPostgresNonceStore } from '@agroasys/shared-auth';
import { DocumentConflictError } from '../errors';
import { isDeepStrictEqual } from 'node:util';

const serviceAuthNonceStore = createPostgresNonceStore({
  tableName: 'ricardian_auth_nonces',
  query: (sql, params) => pool.query(sql, params),
});

export async function createRicardianHash(data: {
  requestId: string;
  documentRef: string;
  hash: string;
  rulesVersion: string;
  canonicalJson: string;
  metadata: Record<string, unknown>;
}): Promise<RicardianHashRow> {
  const inserted = await pool.query<RicardianHashRow>(
    `INSERT INTO ricardian_hashes (
        request_id,
        document_ref,
        hash,
        rules_version,
        canonical_json,
        metadata
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (hash, document_ref)
     DO NOTHING
     RETURNING *`,
    [
      data.requestId,
      data.documentRef,
      data.hash,
      data.rulesVersion,
      data.canonicalJson,
      JSON.stringify(data.metadata),
    ],
  );

  if (inserted.rows[0]) {
    return inserted.rows[0];
  }

  const existing = await pool.query<RicardianHashRow>(
    `SELECT *
     FROM ricardian_hashes
     WHERE hash = $1 AND document_ref = $2
     LIMIT 1`,
    [data.hash, data.documentRef],
  );
  const row = existing.rows[0];
  const isIdentical =
    row?.rules_version === data.rulesVersion &&
    row.canonical_json === data.canonicalJson &&
    isDeepStrictEqual(row.metadata, data.metadata);

  if (!row || !isIdentical) {
    throw new DocumentConflictError(data.hash, data.documentRef);
  }

  return row;
}

export async function getRicardianHash(hash: string): Promise<RicardianHashRow | null> {
  const result = await pool.query<RicardianHashRow>(
    `SELECT *
     FROM ricardian_hashes
     WHERE hash = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [hash],
  );

  return result.rows[0] || null;
}

export async function consumeServiceAuthNonce(
  apiKey: string,
  nonce: string,
  ttlSeconds: number,
): Promise<boolean> {
  return serviceAuthNonceStore.consume(apiKey, nonce, ttlSeconds);
}
