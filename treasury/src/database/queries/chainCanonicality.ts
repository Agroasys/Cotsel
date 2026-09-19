/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persistence for WP-4 B-08 / FAIL-06 chain-canonicality verdicts.
 *
 * A verdict is only worth as much as the record behind it, so the orphaning
 * path writes the evidence row, the revoked entry and the replay watermark in
 * one transaction. A partial write here is the failure the control exists to
 * prevent: an entry marked orphaned with no evidence cannot be reviewed, and
 * evidence with no revocation leaves the entry payable.
 */
import { pool } from '../connection';
import type { PoolClient } from 'pg';
import type { ChainMismatchReason } from '../../core/chainCanonicality';
import type {
  ChainCanonicalityCounts,
  ChainCanonicalityState,
  LedgerChainReorgEvent,
} from '../../core/chainCanonicality';
import type { PayoutState } from '../../types';

/**
 * Promotes an entry to CANONICAL and reports the state the row actually ended
 * in.
 *
 * The caller must not assume the promotion happened. A concurrent assessment
 * can orphan this entry between the read that produced the verdict and this
 * write; the `ORPHANED` guard then matches no row and the update silently does
 * nothing. Returning the resulting state -- read under the same row lock that
 * the update takes -- is what lets the caller fail closed instead of treating a
 * revoked entry as eligible.
 */
export async function markLedgerEntryCanonical(data: {
  ledgerEntryId: number;
  blockHash: string;
  logIndex: number;
  logAddress: string;
  logIdentityHash: string;
  stableBlockNumber: number;
}): Promise<{ state: ChainCanonicalityState }> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    const locked = await client.query<{ canonicality_state: ChainCanonicalityState }>(
      `SELECT canonicality_state
       FROM treasury_ledger_entries
       WHERE id = $1
       FOR UPDATE`,
      [data.ledgerEntryId],
    );

    const current = locked.rows[0]?.canonicality_state;
    if (current === undefined) {
      await client.query('COMMIT');
      return { state: 'UNVERIFIED' };
    }

    if (current === 'ORPHANED') {
      await client.query('COMMIT');
      return { state: 'ORPHANED' };
    }

    const updated = await client.query<{ canonicality_state: ChainCanonicalityState }>(
      `UPDATE treasury_ledger_entries
       SET canonicality_state = 'CANONICAL',
           block_hash = $2,
           log_index = $3,
           log_address = $4,
           log_identity_hash = $5,
           canonicality_verified_at = NOW(),
           canonicality_observed_block_hash = $2,
           canonicality_depth = NULL,
           canonicality_stable_block_number = $6
       WHERE id = $1
       RETURNING canonicality_state`,
      [
        data.ledgerEntryId,
        data.blockHash,
        data.logIndex,
        data.logAddress,
        data.logIdentityHash,
        data.stableBlockNumber,
      ],
    );

    await client.query('COMMIT');
    return { state: updated.rows[0]?.canonicality_state ?? 'UNVERIFIED' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The `ORPHANED` guard above is the important half of this pair. Once the chain
 * has contradicted an entry, a later run that happens to read a matching
 * receipt must not silently clear the revocation; returning an entry to service
 * is an approved correction, not a side effect of a retry.
 */
export async function recordLedgerEntryOrphaned(data: {
  ledgerEntryId: number;
  entryKey: string;
  tradeId: string;
  txHash: string;
  blockNumber: number;
  expectedBlockHash: string | null;
  observedBlockHash: string | null;
  observedBlockNumber: number | null;
  observedLogIndex: number | null;
  reorgDepth: number;
  stableBlockNumber: number;
  mismatchReason: ChainMismatchReason;
  detail: string;
  cancelFromState: PayoutState | null;
  actor: string;
}): Promise<{ evidenceId: number; payoutCancelled: boolean }> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    const evidence = await client.query<{ id: number }>(
      `INSERT INTO treasury_chain_reorg_events (
          ledger_entry_id,
          entry_key,
          trade_id,
          tx_hash,
          block_number,
          expected_block_hash,
          observed_block_hash,
          observed_block_number,
          observed_log_index,
          reorg_depth,
          stable_block_number,
          mismatch_reason,
          detail
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id`,
      [
        data.ledgerEntryId,
        data.entryKey,
        data.tradeId,
        data.txHash,
        data.blockNumber,
        data.expectedBlockHash,
        data.observedBlockHash,
        data.observedBlockNumber,
        data.observedLogIndex,
        data.reorgDepth,
        data.stableBlockNumber,
        data.mismatchReason,
        data.detail,
      ],
    );

    await client.query(
      `UPDATE treasury_ledger_entries
       SET canonicality_state = 'ORPHANED',
           canonicality_verified_at = NOW(),
           canonicality_observed_block_hash = $2,
           canonicality_depth = $3,
           canonicality_stable_block_number = $4
       WHERE id = $1`,
      [data.ledgerEntryId, data.observedBlockHash, data.reorgDepth, data.stableBlockNumber],
    );

    // Revoking eligibility is the guarantee; cancelling the lifecycle is the
    // operator-visible consequence where the lifecycle can still move. An entry
    // already in a terminal state keeps it -- money that has left cannot be
    // un-sent by a state write -- and stays blocked on the canonicality axis
    // until an approved correction.
    let payoutCancelled = false;
    if (data.cancelFromState !== null) {
      await client.query(
        `INSERT INTO payout_lifecycle_events (ledger_entry_id, state, note, actor)
         VALUES ($1, 'CANCELLED', $2, $3)`,
        [
          data.ledgerEntryId,
          `Chain canonicality revoked (${data.mismatchReason}): ${data.detail}`,
          data.actor,
        ],
      );
      payoutCancelled = true;
    }

    // Replay from the affected height so the canonical events that now occupy
    // it are ingested. The watermark only ever moves backwards here; a run that
    // has already passed this block must return to it.
    await client.query(
      `UPDATE treasury_ingestion_state
       SET next_block_number = LEAST(next_block_number, $1),
           updated_at = NOW()
       WHERE next_block_number > $1`,
      [data.blockNumber],
    );

    await client.query('COMMIT');
    return { evidenceId: evidence.rows[0].id, payoutCancelled };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listChainReorgEvents(params: {
  ledgerEntryId?: number;
  limit: number;
}): Promise<LedgerChainReorgEvent[]> {
  const values: Array<number> = [];
  let filter = '';

  if (params.ledgerEntryId !== undefined) {
    values.push(params.ledgerEntryId);
    filter = `WHERE ledger_entry_id = $${values.length}`;
  }

  values.push(params.limit);

  const result = await pool.query<LedgerChainReorgEvent>(
    `SELECT *
     FROM treasury_chain_reorg_events
     ${filter}
     ORDER BY detected_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );

  return result.rows;
}

/**
 * The control summary behind the reorganization drill: how much of the ledger
 * is provably canonical at this moment, and how much is revoked or unproven.
 */
export async function countLedgerEntriesByCanonicality(): Promise<ChainCanonicalityCounts> {
  const result = await pool.query<{ canonicality_state: string; count: string }>(
    `SELECT canonicality_state, COUNT(*)::text AS count
     FROM treasury_ledger_entries
     GROUP BY canonicality_state`,
  );

  const counts: ChainCanonicalityCounts = { canonical: 0, orphaned: 0, unverified: 0 };
  for (const row of result.rows) {
    const value = Number(row.count);
    if (row.canonicality_state === 'CANONICAL') {
      counts.canonical = value;
    } else if (row.canonicality_state === 'ORPHANED') {
      counts.orphaned = value;
    } else {
      counts.unverified += value;
    }
  }

  return counts;
}

/**
 * The height the last completed ingestion run proved coverage through -- the
 * lower of the finalized head and the indexer's processed height. It is the
 * stable block a reconciliation of the canonicality counts is quoted against,
 * so a reader can tell how far the numbers actually reach.
 */
export async function getIngestionStableBlock(): Promise<number | null> {
  const result = await pool.query<{ last_ingested_through_block_number: number | null }>(
    `SELECT MIN(last_ingested_through_block_number) AS last_ingested_through_block_number
     FROM treasury_ingestion_state
     WHERE last_ingested_through_block_number IS NOT NULL`,
  );

  const value = result.rows[0]?.last_ingested_through_block_number;
  return value === null || value === undefined ? null : Number(value);
}
