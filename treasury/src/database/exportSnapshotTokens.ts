/** SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from './connection';

export class ExportTokenUnavailable extends Error {}

/** Tokens contain no client-controlled position or identity; only their hashes are stored. */
export class ExportSnapshotTokens {
  constructor(private readonly db: Pool = defaultPool) {}

  async issue(caller: string, jobId: string, nextPosition: number): Promise<string> {
    if (!Number.isSafeInteger(nextPosition) || nextPosition < 0)
      throw new Error('Invalid export position');
    const token = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(token).digest('hex');
    const result = await this.db.query(
      `INSERT INTO treasury_export_tokens (token_hash, job_id, caller_id, next_position, expires_at)
       SELECT $1, id, caller_id, $4, access_expires_at FROM treasury_export_jobs
       WHERE id=$2 AND caller_id=$3 AND status='COMPLETE' AND access_expires_at > NOW()`,
      [digest, jobId, caller, nextPosition],
    );
    if (result.rowCount !== 1) throw new ExportTokenUnavailable('Completed export is unavailable');
    return token;
  }

  async resolve(caller: string, jobId: string, token: unknown): Promise<number | null> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = createHash('sha256').update(token).digest('hex');
    const result = await this.db.query<{ next_position: string }>(
      `SELECT t.next_position::text FROM treasury_export_tokens t
       JOIN treasury_export_jobs j ON j.id=t.job_id AND j.caller_id=t.caller_id
       WHERE t.token_hash=$1 AND t.job_id=$2 AND t.caller_id=$3 AND t.expires_at > NOW()
         AND j.status='COMPLETE' AND j.access_expires_at > NOW()`,
      [digest, jobId, caller],
    );
    const value = result.rows[0]?.next_position;
    if (value === undefined) return null;
    const position = Number(value);
    return Number.isSafeInteger(position) && position >= 0 ? position : null;
  }
}
