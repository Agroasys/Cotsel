import { pool } from './connection';
import { RicardianHashRow } from '../types';
import { createPostgresNonceStore } from '@agroasys/shared-auth';

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
  const result = await pool.query<RicardianHashRow>(
    `INSERT INTO ricardian_hashes (
        request_id,
        document_ref,
        hash,
        rules_version,
        canonical_json,
        metadata
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (hash, document_ref)
     DO UPDATE SET
       metadata = EXCLUDED.metadata
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

  return result.rows[0];
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
