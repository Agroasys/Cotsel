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

/**
 * The inclusive block height ingestion resumes from. This replaced a row offset
 * into the indexer's result set: an offset is a position in a set that a
 * reorganization can shrink, so events that moved below the cursor were skipped
 * permanently, and it cannot express the finalized upper bound that ingestion
 * is now restricted to. A height is a claim about the chain, which is the thing
 * both properties depend on.
 */
export async function getIngestionWatermark(
  cursorName: string = INGESTION_CURSOR_NAME,
): Promise<number> {
  const result = await pool.query<{ next_block_number: number }>(
    `SELECT next_block_number
     FROM treasury_ingestion_state
     WHERE cursor_name = $1`,
    [cursorName],
  );

  if (result.rows[0]) {
    return Number(result.rows[0].next_block_number);
  }

  await pool.query(
    `INSERT INTO treasury_ingestion_state (cursor_name, next_block_number)
     VALUES ($1, 0)
     ON CONFLICT (cursor_name) DO NOTHING`,
    [cursorName],
  );

  return 0;
}

/**
 * `GREATEST` keeps a completed run from moving the watermark backwards, so a
 * run that overlapped a reorganization rewind cannot undo it on the way out.
 * Only `recordLedgerEntryOrphaned` rewinds, and it does so deliberately.
 */
export async function setIngestionWatermark(
  nextBlockNumber: number,
  cursorName: string = INGESTION_CURSOR_NAME,
  lastFinalizedBlockNumber: number | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_ingestion_state (
       cursor_name, next_block_number, last_finalized_block_number, updated_at
     )
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (cursor_name)
     DO UPDATE SET
       next_block_number = GREATEST(treasury_ingestion_state.next_block_number, EXCLUDED.next_block_number),
       last_finalized_block_number = COALESCE(EXCLUDED.last_finalized_block_number, treasury_ingestion_state.last_finalized_block_number),
       updated_at = NOW()`,
    [cursorName, nextBlockNumber, lastFinalizedBlockNumber],
  );
}

export async function consumeServiceAuthNonce(
  apiKey: string,
  nonce: string,
  ttlSeconds: number,
): Promise<boolean> {
  return serviceAuthNonceStore.consume(apiKey, nonce, ttlSeconds);
}
