/** SPDX-License-Identifier: Apache-2.0 */
import type { PoolClient } from 'pg';

/**
 * Call inside the final publication transaction, after external evidence is
 * rechecked. SHARE locks keep ledger, payout and bank writers out until commit.
 */
export async function capturedSourcesMatch(
  client: PoolClient,
  jobId: string,
  attempt: number,
  cutoff: Date,
): Promise<boolean> {
  await client.query(
    'LOCK TABLE treasury_ledger_entries, payout_lifecycle_events, bank_payout_confirmations IN SHARE MODE',
  );
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
