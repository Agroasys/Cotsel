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
  lastIngestedThroughBlockNumber: number | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_ingestion_state (
       cursor_name, next_block_number, last_ingested_through_block_number, updated_at
     )
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (cursor_name)
     DO UPDATE SET
       next_block_number = GREATEST(treasury_ingestion_state.next_block_number, EXCLUDED.next_block_number),
       last_ingested_through_block_number = COALESCE(EXCLUDED.last_ingested_through_block_number, treasury_ingestion_state.last_ingested_through_block_number),
       updated_at = NOW()`,
    [cursorName, nextBlockNumber, lastIngestedThroughBlockNumber],
  );
}

export async function consumeServiceAuthNonce(
  apiKey: string,
  nonce: string,
  ttlSeconds: number,
): Promise<boolean> {
  return serviceAuthNonceStore.consume(apiKey, nonce, ttlSeconds);
}

/**
 * WP-4 B-09 / FAIL-10.
 *
 * The cursor recorded where ingestion had reached but never when it reached
 * there, so a stopped ingester and a caught-up ingester produced the same row.
 * These four writes give the cursor a clock, and `treasury_ingestion_runs` an
 * append-only account of who ran, over what window, and why they stopped.
 */
export interface IngestionCursorState {
  cursorName: string;
  nextBlockNumber: number;
  lastIngestedThroughBlockNumber: number | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastBlockedReason: string | null;
  lastPartialReason: string | null;
  consecutiveFailureCount: number;
}

type IngestionCursorStateRow = {
  cursor_name: string;
  next_block_number: number;
  last_ingested_through_block_number: number | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_blocked_reason: string | null;
  last_partial_reason: string | null;
  consecutive_failure_count: number;
};

export async function listIngestionCursorStates(
  cursorNames: string[],
): Promise<IngestionCursorState[]> {
  const result = await pool.query<IngestionCursorStateRow>(
    `SELECT cursor_name,
            next_block_number,
            last_ingested_through_block_number,
            last_attempt_at,
            last_success_at,
            last_blocked_reason,
            last_partial_reason,
            consecutive_failure_count
     FROM treasury_ingestion_state
     WHERE cursor_name = ANY($1::text[])
     ORDER BY cursor_name`,
    [cursorNames],
  );

  // `pool` resolves through shared-db, whose `Pool` type does not carry the pg
  // row generic here, so the row is named rather than inferred.
  return result.rows.map((row: IngestionCursorStateRow) => ({
    cursorName: row.cursor_name,
    nextBlockNumber: Number(row.next_block_number),
    lastIngestedThroughBlockNumber:
      row.last_ingested_through_block_number === null
        ? null
        : Number(row.last_ingested_through_block_number),
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastBlockedReason: row.last_blocked_reason,
    lastPartialReason: row.last_partial_reason,
    consecutiveFailureCount: Number(row.consecutive_failure_count),
  }));
}

export async function markIngestionAttemptStarted(cursorNames: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_ingestion_state (cursor_name, next_block_number, last_attempt_at)
     SELECT cursor_name, 0, NOW()
     FROM unnest($1::text[]) AS cursor_name
     ON CONFLICT (cursor_name)
     DO UPDATE SET last_attempt_at = NOW()`,
    [cursorNames],
  );
}

/**
 * Only a run that read its whole window clears the failure counter. A run that
 * refused, or threw, leaves both the counter and the last blocked reason in
 * place so the next readiness read still sees the outage.
 */
export async function markIngestionRunCompleted(cursorNames: string[]): Promise<void> {
  await pool.query(
    `UPDATE treasury_ingestion_state
     SET last_success_at = NOW(),
         last_blocked_reason = NULL,
         last_partial_reason = NULL,
         consecutive_failure_count = 0,
         updated_at = NOW()
     WHERE cursor_name = ANY($1::text[])`,
    [cursorNames],
  );
}

/**
 * A run capped by `TREASURY_INGEST_MAX_EVENTS` read everything it claimed to
 * read and is not a failure, so the failure counter stays where it is. What it
 * did not do is catch up, so it must not advance `last_success_at` either:
 * freshness is the claim that treasury is level with the chain, and a run that
 * stopped short has not established it.
 */
export async function markIngestionRunPartial(
  cursorNames: string[],
  partialReason: string,
): Promise<void> {
  await pool.query(
    `UPDATE treasury_ingestion_state
     SET last_partial_reason = $2,
         last_blocked_reason = NULL,
         updated_at = NOW()
     WHERE cursor_name = ANY($1::text[])`,
    [cursorNames, partialReason],
  );
}

export async function markIngestionRunUnsuccessful(
  cursorNames: string[],
  blockedReason: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_ingestion_state (
       cursor_name, next_block_number, last_attempt_at, last_blocked_reason, consecutive_failure_count
     )
     SELECT cursor_name, 0, NOW(), $2, 1
     FROM unnest($1::text[]) AS cursor_name
     ON CONFLICT (cursor_name)
     DO UPDATE SET
       last_blocked_reason = EXCLUDED.last_blocked_reason,
       consecutive_failure_count = treasury_ingestion_state.consecutive_failure_count + 1,
       updated_at = NOW()`,
    [cursorNames, blockedReason],
  );
}

export type IngestionRunTriggerSource = 'WORKER' | 'CLI' | 'API';
export type IngestionRunOutcome = 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'NOT_OWNER';

export interface IngestionRunRecord {
  runKey: string;
  workerIdentity: string;
  triggerSource: IngestionRunTriggerSource;
  outcome: IngestionRunOutcome;
  fetched: number;
  inserted: number;
  stableBlockNumber: number | null;
  indexerProcessedBlockNumber: number | null;
  ingestedThroughBlockNumber: number | null;
  nextTradeBlockNumber: number | null;
  nextClaimBlockNumber: number | null;
  blockedReason: string | null;
  durationMs: number;
  startedAt: Date;
  metadata?: Record<string, unknown>;
}

export async function recordIngestionRun(record: IngestionRunRecord): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_ingestion_runs (
       run_key, worker_identity, trigger_source, outcome, fetched, inserted,
       stable_block_number, indexer_processed_block_number, ingested_through_block_number,
       next_trade_block_number, next_claim_block_number, blocked_reason,
       duration_ms, started_at, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (run_key) DO NOTHING`,
    [
      record.runKey,
      record.workerIdentity,
      record.triggerSource,
      record.outcome,
      record.fetched,
      record.inserted,
      record.stableBlockNumber,
      record.indexerProcessedBlockNumber,
      record.ingestedThroughBlockNumber,
      record.nextTradeBlockNumber,
      record.nextClaimBlockNumber,
      record.blockedReason,
      record.durationMs,
      record.startedAt,
      JSON.stringify(record.metadata ?? {}),
    ],
  );
}
