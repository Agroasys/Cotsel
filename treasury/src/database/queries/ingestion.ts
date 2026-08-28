/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createPostgresNonceStore } from '@agroasys/shared-auth';
import { pool } from '../connection';

const INGESTION_CURSOR_NAME = 'trade_events';
const serviceAuthNonceStore = createPostgresNonceStore({
  tableName: 'treasury_auth_nonces',
  query: (sql, params) => pool.query(sql, params),
});

export async function getIngestionOffset(
  cursorName: string = INGESTION_CURSOR_NAME,
): Promise<number> {
  const result = await pool.query<{ next_offset: number }>(
    `SELECT next_offset
     FROM treasury_ingestion_state
     WHERE cursor_name = $1`,
    [cursorName],
  );

  if (result.rows[0]) {
    return Number(result.rows[0].next_offset);
  }

  await pool.query(
    `INSERT INTO treasury_ingestion_state (cursor_name, next_offset)
     VALUES ($1, 0)
     ON CONFLICT (cursor_name) DO NOTHING`,
    [cursorName],
  );

  return 0;
}

export async function setIngestionOffset(
  nextOffset: number,
  cursorName: string = INGESTION_CURSOR_NAME,
): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_ingestion_state (cursor_name, next_offset, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_name)
     DO UPDATE SET
       next_offset = EXCLUDED.next_offset,
       updated_at = NOW()`,
    [cursorName, nextOffset],
  );
}

export async function consumeServiceAuthNonce(
  apiKey: string,
  nonce: string,
  ttlSeconds: number,
): Promise<boolean> {
  return serviceAuthNonceStore.consume(apiKey, nonce, ttlSeconds);
}
