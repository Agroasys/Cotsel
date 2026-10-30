/** SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from './connection';

interface JobRow {
  id: string;
  caller_id: string;
  request_hash: string;
  cutoff: Date;
  status: 'BUILDING' | 'FAILED' | 'COMPLETE';
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  access_expires_at: Date;
  updated_at: Date;
  candidate_count: string | null;
  candidate_amount_raw: string | null;
  failure_code: string | null;
  chain_context: Record<string, unknown> | null;
  reconciliation_context: Record<string, unknown> | null;
  ingestion_context: Record<string, unknown> | null;
}

export class ExportJobConflict extends Error {}

/** Durable candidate capture. RPC and reconciliation reads never run in this transaction. */
export class ExportSnapshotStore {
  constructor(private readonly db: Pool = defaultPool) {}

  async create(caller: string, idempotencyKey: string, cutoff: Date): Promise<JobRow> {
    if (
      !caller ||
      caller.length > 255 ||
      !idempotencyKey ||
      idempotencyKey.length > 255 ||
      !Number.isFinite(cutoff.getTime())
    ) {
      throw new Error('Invalid export identity or cutoff');
    }
    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    const requestHash = createHash('sha256')
      .update(`treasury-export-v1|${cutoff.toISOString()}`)
      .digest('hex');
    const inserted = await this.db.query<JobRow>(
      `INSERT INTO treasury_export_jobs
       (id, caller_id, idempotency_key_hash, request_hash, cutoff, status, attempt, access_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'BUILDING', 1, NOW() + interval '24 hours')
       ON CONFLICT (caller_id, idempotency_key_hash) DO NOTHING RETURNING *`,
      [randomUUID(), caller, keyHash, requestHash, cutoff],
    );
    const existing =
      inserted.rows[0] ??
      (
        await this.db.query<JobRow>(
          'SELECT * FROM treasury_export_jobs WHERE caller_id = $1 AND idempotency_key_hash = $2 AND access_expires_at > NOW()',
          [caller, keyHash],
        )
      ).rows[0];
    if (!existing) throw new ExportJobConflict('The idempotency key belongs to an expired export');
    if (existing.request_hash !== requestHash)
      throw new ExportJobConflict('Idempotency key is bound to a different export request');
    return existing;
  }

  async get(caller: string, jobId: string): Promise<JobRow | null> {
    const result = await this.db.query<JobRow>(
      'SELECT * FROM treasury_export_jobs WHERE id = $1 AND caller_id = $2 AND access_expires_at > NOW()',
      [jobId, caller],
    );
    return result.rows[0] ?? null;
  }

  /** Claim an abandoned or failed build. Each retry captures a fresh snapshot. */
  async claim(jobId: string, owner: string, leaseSeconds: number): Promise<JobRow | null> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1)
      throw new Error('Invalid lease duration');
    const result = await this.db.query<JobRow>(
      `UPDATE treasury_export_jobs SET
         attempt = CASE WHEN status = 'FAILED' OR lease_owner IS NOT NULL THEN attempt + 1 ELSE attempt END,
         status = 'BUILDING', lease_owner = $2, lease_expires_at = NOW() + ($3 * interval '1 second'),
         candidate_count = NULL, candidate_amount_raw = NULL, failure_code = NULL, updated_at = NOW()
       WHERE id = $1 AND access_expires_at > NOW() AND status <> 'COMPLETE'
         AND (lease_owner IS NULL OR lease_expires_at <= NOW()) RETURNING *`,
      [jobId, owner, leaseSeconds],
    );
    return result.rows[0] ?? null;
  }

  async capture(jobId: string, owner: string, maxRows: number): Promise<void> {
    if (!Number.isSafeInteger(maxRows) || maxRows <= 5000 || maxRows > 1000000)
      throw new Error('Export job limit must be between 5001 and 1000000');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const locked = await client.query<JobRow>(
        `SELECT * FROM treasury_export_jobs WHERE id = $1 AND status = 'BUILDING'
         AND lease_owner = $2 AND lease_expires_at > NOW() FOR UPDATE`,
        [jobId, owner],
      );
      const job = locked.rows[0];
      if (!job) throw new ExportJobConflict('Export build lease is unavailable');
      const totals = await client.query<{ count: string; total: string }>(
        `SELECT COUNT(*)::text AS count, COALESCE(SUM(amount_raw::numeric), 0)::text AS total
         FROM treasury_ledger_entries WHERE created_at <= $1`,
        [job.cutoff],
      );
      const { count, total } = totals.rows[0];
      if (BigInt(count) > BigInt(maxRows)) throw new Error('Export job size limit exceeded');
      await client.query(
        `INSERT INTO treasury_export_rows (job_id, attempt, position, ledger_entry_id, captured_row, source_evidence)
         SELECT $1, $2, row_number() OVER (ORDER BY e.created_at DESC, e.id DESC) - 1, e.id,
                to_jsonb(e) || jsonb_build_object('latest_state', p.state, 'latest_state_at', p.created_at),
                jsonb_build_object('payout', to_jsonb(p), 'bank', to_jsonb(b))
         FROM treasury_ledger_entries e
         LEFT JOIN LATERAL (SELECT * FROM payout_lifecycle_events WHERE ledger_entry_id=e.id ORDER BY created_at DESC, id DESC LIMIT 1) p ON TRUE
         LEFT JOIN LATERAL (SELECT * FROM bank_payout_confirmations WHERE ledger_entry_id=e.id ORDER BY confirmed_at DESC, id DESC LIMIT 1) b ON TRUE
         WHERE e.created_at <= $3`,
        [jobId, job.attempt, job.cutoff],
      );
      await client.query(
        'UPDATE treasury_export_jobs SET candidate_count=$2, candidate_amount_raw=$3, updated_at=NOW() WHERE id=$1',
        [jobId, count, total],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await client.query(
        `UPDATE treasury_export_jobs SET status='FAILED', failure_code=$3, lease_owner=NULL,
         lease_expires_at=NULL, updated_at=NOW() WHERE id=$1 AND status='BUILDING' AND lease_owner=$2`,
        [
          jobId,
          owner,
          error instanceof Error && error.message === 'Export job size limit exceeded'
            ? 'JOB_SIZE_LIMIT_EXCEEDED'
            : 'CAPTURE_FAILED',
        ],
      );
      throw error;
    } finally {
      client.release();
    }
  }
}
