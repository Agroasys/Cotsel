/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool, PoolClient } from 'pg';

export async function readSourceGeneration(client: Pool | PoolClient): Promise<string> {
  const guards = await client.query<{ count: string }>(`SELECT count(*)::text AS count
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('treasury_ledger_entries','payout_lifecycle_events','bank_payout_confirmations','treasury_ingestion_state')
      AND t.tgname='treasury_export_source_generation' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal`);
  if (guards.rows[0]?.count !== '4') throw new Error('Export source guard unavailable');
  const result = await client.query<{ generation: string }>(`SELECT concat_ws(':',
    (SELECT last_value::text || '/' || is_called::text FROM treasury_export_ledger_generation),
    (SELECT last_value::text || '/' || is_called::text FROM treasury_export_payout_generation),
    (SELECT last_value::text || '/' || is_called::text FROM treasury_export_bank_generation),
    (SELECT last_value::text || '/' || is_called::text FROM treasury_export_ingestion_generation)) AS generation`);
  return result.rows[0].generation;
}

/**
 * Compare captured rows without blocking financial writers. The publication
 * transaction must subsequently lock sources and check the generation fence.
 */
export async function capturedSourcesMatch(
  client: Pool | PoolClient,
  jobId: string,
  attempt: number,
  cutoff: Date,
): Promise<boolean> {
  const result = await client.query<{ mismatches: string }>(
    `WITH captured AS (
       SELECT * FROM treasury_export_rows WHERE job_id=$1 AND attempt=$2
     ), current_rows AS (
       SELECT e.id, to_jsonb(e) AS entry, to_jsonb(p) AS payout, to_jsonb(b) AS bank
       FROM treasury_ledger_entries e
       LEFT JOIN LATERAL (SELECT * FROM payout_lifecycle_events WHERE ledger_entry_id=e.id ORDER BY created_at DESC, id DESC LIMIT 1) p ON TRUE
       LEFT JOIN LATERAL (SELECT * FROM bank_payout_confirmations WHERE ledger_entry_id=e.id ORDER BY confirmed_at DESC, id DESC LIMIT 1) b ON TRUE
       WHERE e.created_at <= $3
     )
     SELECT COUNT(*)::text AS mismatches FROM captured c FULL JOIN current_rows s ON s.id=c.ledger_entry_id
     WHERE c.ledger_entry_id IS NULL OR s.id IS NULL OR c.eligibility IS NULL
       OR (s.entry - ARRAY['canonicality_state','canonicality_verified_at','canonicality_observed_block_hash','canonicality_depth','canonicality_stable_block_number'])
          IS DISTINCT FROM (c.captured_row - ARRAY['latest_state','latest_state_at','canonicality_state','canonicality_verified_at','canonicality_observed_block_hash','canonicality_depth','canonicality_stable_block_number'])
       OR COALESCE(s.payout, 'null'::jsonb) IS DISTINCT FROM c.source_evidence->'payout'
       OR COALESCE(s.bank, 'null'::jsonb) IS DISTINCT FROM c.source_evidence->'bank'
       OR s.entry->>'canonicality_state' IS DISTINCT FROM c.eligibility->>'canonicalityState'`,
    [jobId, attempt, cutoff],
  );
  return result.rows[0]?.mismatches === '0';
}

/** Run the expensive read with a local deadline and no financial write locks. */
export async function compareCapturedSourcesWithTimeout(
  pool: Pool,
  jobId: string,
  attempt: number,
  cutoff: Date,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    const matches = await capturedSourcesMatch(client, jobId, attempt, cutoff);
    await client.query('COMMIT');
    return matches;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
