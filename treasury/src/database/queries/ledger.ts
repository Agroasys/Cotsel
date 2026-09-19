/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { pool } from '../connection';
import { assertCanonicalRawAmount } from '../../core/canonicalAmount';
import { normalizeBlockHash, normalizeLogAddress } from '../../core/chainCanonicality';
import type {
  BankPayoutConfirmation,
  LedgerEntry,
  LedgerEntryWithState,
  PayoutLifecycleEvent,
  PayoutState,
  TreasuryComponent,
} from '../../types';

/**
 * The row shape the export produces. Its lateral join is a LEFT join, so a
 * ledger entry with no payout lifecycle event still appears and carries a null
 * state. Every `LedgerEntryWithState` is assignable to this, so a reader that
 * tolerates a null state accepts either shape.
 */
export interface LedgerEntryForExport extends LedgerEntry {
  latest_state: PayoutState | null;
  latest_state_at: Date | null;
}

/**
 * Every field a CANONICAL verdict asserted something about. The verdict is kept
 * across a re-ingest only when all of them are unchanged; anything else drops
 * the entry back to UNVERIFIED.
 */
const PROOF_UNCHANGED = [
  'trade_id',
  'tx_hash',
  'block_number',
  'block_hash',
  'log_index',
  'event_name',
  'component_type',
  'amount_raw',
  'log_address',
  'log_identity_hash',
]
  .map((column) => `treasury_ledger_entries.${column} IS NOT DISTINCT FROM EXCLUDED.${column}`)
  .join('\n              AND ');

export async function upsertLedgerEntryWithInitialState(data: {
  entryKey: string;
  tradeId: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  logAddress: string | null;
  logIdentityHash: string | null;
  eventName: string;
  componentType: TreasuryComponent;
  amountRaw: string;
  sourceTimestamp: Date;
  metadata: Record<string, unknown>;
  initialStateNote?: string;
  initialStateActor?: string;
}): Promise<{ entry: LedgerEntry; initialStateCreated: boolean }> {
  // Ingress is the last point where a non-canonical amount can still be
  // attributed to its source event rather than discovered during a close.
  assertCanonicalRawAmount(data.amountRaw, 'amountRaw');

  const blockHash = normalizeBlockHash(data.blockHash);
  if (!blockHash) {
    throw new Error(`blockHash is not a canonical block hash: ${data.blockHash}`);
  }
  if (!Number.isInteger(data.logIndex) || data.logIndex < 0) {
    throw new Error(`logIndex must be a non-negative integer, received ${data.logIndex}`);
  }

  // A partial identity is stored as no identity. Half of it cannot verify
  // anything, and the CANONICAL check constraint would reject it later anyway.
  const logAddress = normalizeLogAddress(data.logAddress);
  if (data.logAddress !== null && !logAddress) {
    throw new Error(`logAddress is not a canonical contract address: ${data.logAddress}`);
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const entryResult = await client.query<LedgerEntry>(
      // The `WHERE` on the conflict path is what keeps a revocation from being
      // undone by a routine re-ingest. An ORPHANED entry is preserved exactly as
      // the reorganization left it; returning it to service is an approved
      // correction, never a side effect of the ingester running again.
      //
      // A CANONICAL verdict is a proof about one exact row: this amount, for
      // this trade, from this log. So the verdict survives only a byte-identical
      // re-ingest. If any field the proof covered changed -- including the
      // payable amount -- the proof no longer describes what is stored, and the
      // entry returns to UNVERIFIED and has to earn CANONICAL again from the
      // chain. Comparing only the block hash and log position here would let a
      // later source correction move the payable amount underneath a recorded
      // proof.
      `INSERT INTO treasury_ledger_entries (
          entry_key,
          trade_id,
          tx_hash,
          block_number,
          block_hash,
          log_index,
          log_address,
          log_identity_hash,
          event_name,
          component_type,
          amount_raw,
          source_timestamp,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT (entry_key)
        DO UPDATE SET
          trade_id = EXCLUDED.trade_id,
          tx_hash = EXCLUDED.tx_hash,
          block_number = EXCLUDED.block_number,
          block_hash = EXCLUDED.block_hash,
          log_index = EXCLUDED.log_index,
          log_address = EXCLUDED.log_address,
          log_identity_hash = EXCLUDED.log_identity_hash,
          event_name = EXCLUDED.event_name,
          component_type = EXCLUDED.component_type,
          amount_raw = EXCLUDED.amount_raw,
          source_timestamp = EXCLUDED.source_timestamp,
          metadata = EXCLUDED.metadata,
          canonicality_state = CASE
            WHEN ${PROOF_UNCHANGED} THEN treasury_ledger_entries.canonicality_state
            ELSE 'UNVERIFIED'
          END,
          canonicality_verified_at = CASE
            WHEN ${PROOF_UNCHANGED} THEN treasury_ledger_entries.canonicality_verified_at
            ELSE NULL
          END
        WHERE treasury_ledger_entries.canonicality_state <> 'ORPHANED'
        RETURNING *`,
      [
        data.entryKey,
        data.tradeId,
        data.txHash,
        data.blockNumber,
        blockHash,
        data.logIndex,
        logAddress,
        data.logIdentityHash,
        data.eventName,
        data.componentType,
        data.amountRaw,
        data.sourceTimestamp,
        JSON.stringify(data.metadata),
      ],
    );

    // No row comes back when the conflict target exists but the `WHERE` above
    // declined the update, which is the orphaned case. Read it so the caller
    // still receives the entry it asked about instead of a crash.
    const entry =
      entryResult.rows[0] ??
      (
        await client.query<LedgerEntry>(
          'SELECT * FROM treasury_ledger_entries WHERE entry_key = $1',
          [data.entryKey],
        )
      ).rows[0];

    const initialStateResult = await client.query(
      `INSERT INTO payout_lifecycle_events (
          ledger_entry_id,
          state,
          note,
          actor
        )
        SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (
          SELECT 1
          FROM payout_lifecycle_events
          WHERE ledger_entry_id = $1
        )`,
      [
        entry.id,
        'PENDING_REVIEW',
        data.initialStateNote || 'Auto-created from indexer ingestion',
        data.initialStateActor || 'system:indexer-ingest',
      ],
    );

    await client.query('COMMIT');

    return {
      entry,
      initialStateCreated: (initialStateResult.rowCount ?? 0) > 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function appendPayoutState(data: {
  ledgerEntryId: number;
  state: PayoutState;
  note?: string;
  actor?: string;
}): Promise<PayoutLifecycleEvent> {
  const result = await pool.query<PayoutLifecycleEvent>(
    `INSERT INTO payout_lifecycle_events (
      ledger_entry_id,
      state,
      note,
      actor
    ) VALUES ($1, $2, $3, $4)
    RETURNING *`,
    [data.ledgerEntryId, data.state, data.note || null, data.actor || null],
  );

  return result.rows[0];
}

export async function getLatestPayoutState(
  ledgerEntryId: number,
): Promise<PayoutLifecycleEvent | null> {
  const result = await pool.query<PayoutLifecycleEvent>(
    `SELECT *
     FROM payout_lifecycle_events
     WHERE ledger_entry_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [ledgerEntryId],
  );

  return result.rows[0] || null;
}

export async function getLatestBankPayoutConfirmation(
  ledgerEntryId: number,
): Promise<BankPayoutConfirmation | null> {
  const result = await pool.query<BankPayoutConfirmation>(
    `SELECT *
     FROM bank_payout_confirmations
     WHERE ledger_entry_id = $1
     ORDER BY confirmed_at DESC, id DESC
     LIMIT 1`,
    [ledgerEntryId],
  );

  return result.rows[0] || null;
}

export async function getLedgerEntries(params: {
  tradeId?: string;
  state?: PayoutState;
  limit: number;
  offset: number;
}): Promise<LedgerEntryWithState[]> {
  const values: Array<string | number> = [];
  const filters: string[] = [];

  if (params.tradeId) {
    values.push(params.tradeId);
    filters.push(`e.trade_id = $${values.length}`);
  }

  if (params.state) {
    values.push(params.state);
    filters.push(`s.state = $${values.length}`);
  }

  values.push(params.limit);
  const limitParam = `$${values.length}`;

  values.push(params.offset);
  const offsetParam = `$${values.length}`;

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const result = await pool.query<LedgerEntryWithState>(
    `SELECT
        e.*,
        s.state AS latest_state,
        s.created_at AS latest_state_at
      FROM treasury_ledger_entries e
      JOIN LATERAL (
        SELECT p.state, p.created_at
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) s ON TRUE
      ${whereClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );

  return result.rows;
}

/**
 * Counts and totals the candidate set at the export cutoff. The consumer
 * reconciles the pages it received against these two numbers, which is what
 * makes "every record exactly once" checkable rather than assumed.
 */
export async function getLedgerExportSnapshot(cutoff: Date): Promise<{
  rowCount: number;
  totalAmountRaw: string;
}> {
  const result = await pool.query<{ row_count: string; total_amount_raw: string | null }>(
    `SELECT
        COUNT(*)::text AS row_count,
        COALESCE(SUM(e.amount_raw::numeric), 0)::text AS total_amount_raw
      FROM treasury_ledger_entries e
      WHERE e.created_at <= $1`,
    [cutoff],
  );

  const row = result.rows[0];
  return {
    rowCount: Number(row?.row_count ?? '0'),
    totalAmountRaw: row?.total_amount_raw ?? '0',
  };
}

/**
 * Keyset page over `(created_at DESC, id DESC)` bounded by the export cutoff.
 * Offset paging was the original defect: a row inserted between pages shifts
 * every later offset, so rows are silently skipped or repeated.
 *
 * The lateral join is a LEFT join so this enumerates exactly the candidate set
 * `getLedgerExportSnapshot` counts. An inner join would drop a ledger entry that
 * has no payout lifecycle event yet, and that entry would be counted in the
 * snapshot but never appear on any page, so the pages could never reconcile.
 * Such an entry carries a null state and is scanned but never exported.
 *
 * Fetches one row beyond the page to detect continuation without a second query.
 */
export async function getLedgerEntriesForExport(params: {
  cutoff: Date;
  cursor: { createdAt: Date; id: number } | null;
  limit: number;
}): Promise<{ entries: LedgerEntryForExport[]; hasMore: boolean }> {
  const values: Array<string | number | Date> = [params.cutoff];
  let cursorClause = '';

  if (params.cursor) {
    values.push(params.cursor.createdAt, params.cursor.id);
    cursorClause = `AND (e.created_at, e.id) < ($${values.length - 1}, $${values.length})`;
  }

  values.push(params.limit + 1);

  const result = await pool.query<LedgerEntryForExport>(
    `SELECT
        e.*,
        s.state AS latest_state,
        s.created_at AS latest_state_at
      FROM treasury_ledger_entries e
      LEFT JOIN LATERAL (
        SELECT p.state, p.created_at
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE e.created_at <= $1
      ${cursorClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${values.length}`,
    values,
  );

  const hasMore = result.rows.length > params.limit;
  return {
    entries: hasMore ? result.rows.slice(0, params.limit) : result.rows,
    hasMore,
  };
}

export async function listDistinctLedgerTradeIds(): Promise<string[]> {
  const result = await pool.query<{ trade_id: string }>(
    `SELECT DISTINCT trade_id
     FROM treasury_ledger_entries
     ORDER BY trade_id ASC`,
  );

  return result.rows
    .map((row: { trade_id: string }) => row.trade_id.trim())
    .filter((tradeId: string) => tradeId.length > 0);
}

export async function getLedgerEntryById(entryId: number): Promise<LedgerEntry | null> {
  const result = await pool.query<LedgerEntry>(
    'SELECT * FROM treasury_ledger_entries WHERE id = $1',
    [entryId],
  );

  return result.rows[0] || null;
}

export async function getLedgerEntryByTradeId(tradeId: string): Promise<LedgerEntry | null> {
  const result = await pool.query<LedgerEntry>(
    `SELECT *
     FROM treasury_ledger_entries
     WHERE trade_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [tradeId],
  );

  return result.rows[0] || null;
}
