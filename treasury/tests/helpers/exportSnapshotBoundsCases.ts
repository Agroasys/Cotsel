/** SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export function registerExportSnapshotBoundsCases(
  connections: () => { pool: Pool; runtime: PoolClient },
): void {
  test('bounds retained jobs and attempts atomically, including expired callers and retries', async () => {
    const { pool } = connections();
    const { ExportSnapshotStore } = await import('../../src/database/exportSnapshotStore');
    const store = new ExportSnapshotStore(pool);
    const caller = 'bounded-' + randomUUID();
    const cutoff = new Date('2010-01-01');
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => store.create(caller, String(index), cutoff)),
    );
    const created = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.create>>> =>
        result.status === 'fulfilled',
    );
    expect(created).toHaveLength(10);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2);
    const existing = created[0].value;
    // Exact idempotency remains usable after the caller reaches its budget.
    const replayIndex = results.findIndex(
      (result) => result.status === 'fulfilled' && result.value.id === existing.id,
    );
    expect((await store.create(caller, String(replayIndex), cutoff)).id).toBe(existing.id);
    await pool.query(
      "UPDATE treasury_export_jobs SET access_expires_at=clock_timestamp()-interval '1 second' WHERE caller_id=$1",
      [caller],
    );
    await expect(store.create(caller, 'new-key', cutoff)).rejects.toThrow(/storage budget/);
    const retry = await store.create('retry-' + randomUUID(), 'retry', cutoff);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await store.claim(retry.id, randomUUID(), 10))?.attempt).toBe(attempt);
      await pool.query(
        "UPDATE treasury_export_jobs SET status='FAILED',failure_code='TEST_FAILURE',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [retry.id],
      );
    }
    expect(await store.claim(retry.id, randomUUID(), 10)).toBeNull();
    await expect(
      pool.query('UPDATE treasury_export_jobs SET attempt=4 WHERE id=$1', [retry.id]),
    ).rejects.toThrow(/attempt_budget/);
  });

  test('initial fence rejects a writer that has changed a source but not committed', async () => {
    const { pool } = connections();
    const { captureQuiescentSourceGeneration } =
      await import('../../src/database/exportSnapshotVerification');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE treasury_ingestion_state SET next_block_number=next_block_number');
      await expect(captureQuiescentSourceGeneration(pool)).rejects.toThrow(/could not obtain lock/);
      await writer.query('COMMIT');
      await expect(captureQuiescentSourceGeneration(pool)).resolves.toEqual(expect.any(String));
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  test('generation guards fail closed and runtime cannot reset the fence', async () => {
    const { pool, runtime } = connections();
    const { readSourceGeneration } = await import('../../src/database/exportSnapshotVerification');
    const first = await readSourceGeneration(runtime);
    const writer = await pool.connect();
    await writer.query('BEGIN');
    try {
      await writer.query('UPDATE treasury_ingestion_state SET next_block_number=next_block_number');
      await writer.query('ROLLBACK');
      expect(await readSourceGeneration(runtime)).not.toBe(first);
      await expect(
        runtime.query("SELECT setval('treasury_export_ledger_generation', 1)"),
      ).rejects.toThrow(/permission denied/);
      await pool.query(
        'ALTER TABLE treasury_ledger_entries DISABLE TRIGGER treasury_export_source_generation',
      );
      await expect(readSourceGeneration(runtime)).rejects.toThrow(/guard unavailable/);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await pool.query(
        'ALTER TABLE treasury_ledger_entries ENABLE TRIGGER treasury_export_source_generation',
      );
    }
  });
  test('reuses opaque tokens per position and rejects positions outside the snapshot', async () => {
    const { pool } = connections();
    const { ExportSnapshotTokens } = await import('../../src/database/exportSnapshotTokens');
    const row = (
      await pool.query(
        "SELECT id, caller_id, candidate_count FROM treasury_export_jobs WHERE status='COMPLETE' AND candidate_count>0 AND access_expires_at>clock_timestamp() ORDER BY candidate_count DESC LIMIT 1",
      )
    ).rows[0];
    expect(row).toBeDefined();
    const tokens = new ExportSnapshotTokens(pool);
    const issued = await Promise.all(
      Array.from({ length: 20 }, () => tokens.issue(row.caller_id, row.id, 0)),
    );
    expect(new Set(issued).size).toBe(1);
    expect(await tokens.resolve(row.caller_id, row.id, issued[0])).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*) FROM treasury_export_tokens WHERE job_id=$1 AND next_position=0 AND token_version=1',
          [row.id],
        )
      ).rows[0].count,
    ).toBe('1');
    await expect(
      tokens.issue(row.caller_id, row.id, Number(row.candidate_count) + 1),
    ).rejects.toThrow(/unavailable/);
    await expect(
      pool.query(
        `INSERT INTO treasury_export_tokens(token_hash,job_id,caller_id,next_position,expires_at,token_version)
      VALUES(repeat('a',64),$1,$2,$3,clock_timestamp()+interval '1 hour',1)`,
        [row.id, row.caller_id, Number(row.candidate_count) + 1],
      ),
    ).rejects.toThrow(/position_exceeded/);
  });

  test('global job budget cannot be bypassed with different caller identities', async () => {
    const { pool } = connections();
    const { ExportSnapshotStore } = await import('../../src/database/exportSnapshotStore');
    const store = new ExportSnapshotStore(pool);
    const count = Number(
      (await pool.query('SELECT count(*) FROM treasury_export_jobs')).rows[0].count,
    );
    for (let index = count; index < 100; index++)
      await store.create('global-' + randomUUID(), 'global', new Date('2010-01-01'));
    await expect(
      store.create('new-caller-' + randomUUID(), 'new-key', new Date('2010-01-01')),
    ).rejects.toThrow(/storage budget/);
    expect((await pool.query('SELECT count(*) FROM treasury_export_jobs')).rows[0].count).toBe(
      '100',
    );
  });
}
