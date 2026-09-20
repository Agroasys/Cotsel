/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-11, at the sweep batch.
 *
 * The ledger-entry handoff kept an append-only evidence log; the batch handoff
 * kept only its own row. A callback that did not advance the authoritative
 * state therefore left no trace: a reordered delivery was dropped outright, and
 * a repeated one overwrote the stored evidence reference on its way past. This
 * suite drives the real schema, because the log's immutability and the
 * applied-only-on-advance rule are enforced there.
 */
import { Pool } from 'pg';
import {
  applyTreasuryTestEnv,
  provisionTreasuryDatabase,
  runPostgresIntegrationTests,
} from './helpers/treasuryPostgres';

type TreasuryQueries = typeof import('../src/database/queries');
type TreasuryConnection = typeof import('../src/database/connection');

const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

describePostgres('sweep batch handoff evidence log (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: TreasuryQueries;
  let connection: TreasuryConnection;
  let sidecar: Pool;
  let periodId: number;
  let sequence = 0;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_batch_handoff_events');
    cleanup = provisioned.cleanup;
    applyTreasuryTestEnv(provisioned.dbName);

    jest.resetModules();
    queries = await import('../src/database/queries');
    connection = await import('../src/database/connection');

    sidecar = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: provisioned.dbName,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

    const period = await sidecar.query<{ id: number }>(
      `INSERT INTO accounting_periods (period_key, starts_at, ends_at, status, created_by)
       VALUES ('2026-04', '2026-04-01', '2026-05-01', 'OPEN', 'test')
       RETURNING id`,
    );
    periodId = period.rows[0].id;
  });

  afterAll(async () => {
    await sidecar?.end();
    await connection?.closeConnection();
    await cleanup?.();
  });

  async function seedBatch(): Promise<number> {
    sequence += 1;
    const batch = await sidecar.query<{ id: number }>(
      `INSERT INTO sweep_batches (
         batch_key, accounting_period_id, asset_symbol, status, expected_total_raw,
         matched_sweep_tx_hash, matched_swept_at, created_by
       )
       VALUES ($1, $2, 'USDC', 'EXECUTED', '1000', $3, NOW(), 'test')
       RETURNING id`,
      [`batch-${sequence}`, periodId, `0xsweep${sequence}`],
    );
    return batch.rows[0].id;
  }

  function callback(
    batchId: number,
    handoffStatus: 'CREATED' | 'SUBMITTED' | 'ACKNOWLEDGED' | 'COMPLETED' | 'FAILED',
    evidenceReference?: string | null,
  ) {
    return queries.upsertPartnerHandoff({
      sweepBatchId: batchId,
      partnerName: 'bridge',
      partnerReference: `bridge-ref-${batchId}`,
      handoffStatus,
      evidenceReference: evidenceReference ?? null,
    });
  }

  async function events(batchId: number) {
    const result = await sidecar.query(
      `SELECT handoff_status, transition, applied, evidence_reference
       FROM partner_handoff_events
       WHERE sweep_batch_id = $1
       ORDER BY id`,
      [batchId],
    );
    return result.rows as Array<{
      handoff_status: string;
      transition: string;
      applied: boolean;
      evidence_reference: string | null;
    }>;
  }

  it('records the delivery that establishes the handoff', async () => {
    const batchId = await seedBatch();

    await callback(batchId, 'SUBMITTED');

    expect(await events(batchId)).toEqual([
      expect.objectContaining({
        handoff_status: 'SUBMITTED',
        transition: 'ADVANCE',
        applied: true,
      }),
    ]);
  });

  /**
   * The reordered delivery used to be dropped on an early return, leaving no
   * record that the provider had sent it at all.
   */
  it('records a reordered callback instead of discarding it', async () => {
    const batchId = await seedBatch();
    await callback(batchId, 'ACKNOWLEDGED');

    const handoff = await callback(batchId, 'SUBMITTED');

    expect(handoff.handoff_status).toBe('ACKNOWLEDGED');
    expect(await events(batchId)).toEqual([
      expect.objectContaining({ handoff_status: 'ACKNOWLEDGED', applied: true }),
      expect.objectContaining({ handoff_status: 'SUBMITTED', transition: 'STALE', applied: false }),
    ]);
  });

  /**
   * The repeat used to fall through to the upsert, where `evidence_reference`
   * was assigned straight from the incoming payload -- so a replay carrying no
   * receipt erased the receipt the batch already had.
   */
  it('does not let a replayed callback erase stored evidence', async () => {
    const batchId = await seedBatch();
    await callback(batchId, 'ACKNOWLEDGED', 'receipt-1');

    const replayed = await callback(batchId, 'ACKNOWLEDGED', null);

    expect(replayed.evidence_reference).toBe('receipt-1');
    expect(await events(batchId)).toEqual([
      expect.objectContaining({ handoff_status: 'ACKNOWLEDGED', transition: 'ADVANCE' }),
      expect.objectContaining({
        handoff_status: 'ACKNOWLEDGED',
        transition: 'REPLAY',
        applied: false,
      }),
    ]);
  });

  /**
   * A completion nobody corroborated is refused, but it is still something the
   * provider claimed. Refusing before recording it would delete the claim, and
   * the claim is exactly what a later dispute turns on.
   */
  it('records a batch completion carrying no evidence, then refuses it', async () => {
    const batchId = await seedBatch();
    await callback(batchId, 'SUBMITTED');

    await expect(callback(batchId, 'COMPLETED', null)).rejects.toThrow(
      /authoritative provider or bank evidence/i,
    );

    expect(await events(batchId)).toEqual([
      expect.objectContaining({ handoff_status: 'SUBMITTED', transition: 'ADVANCE' }),
      expect.objectContaining({
        handoff_status: 'COMPLETED',
        transition: 'REJECTED',
        applied: false,
      }),
    ]);

    const stored = await sidecar.query(
      `SELECT handoff_status FROM partner_handoffs WHERE sweep_batch_id = $1`,
      [batchId],
    );
    expect(stored.rows[0].handoff_status).toBe('SUBMITTED');
  });

  /**
   * The deliveries that arrive *after* a contradiction are the ones a dispute
   * turns on, and they used to be dropped at the frozen guard before anything
   * was written. The projection stays frozen; the log keeps growing.
   */
  it('retains provider deliveries that arrive while the batch is frozen', async () => {
    const batchId = await seedBatch();
    await callback(batchId, 'COMPLETED', 'receipt-3');
    await expect(callback(batchId, 'FAILED')).rejects.toThrow(/already terminal at COMPLETED/i);

    await expect(callback(batchId, 'ACKNOWLEDGED', 'receipt-4')).rejects.toThrow(/frozen/i);
    await expect(callback(batchId, 'FAILED')).rejects.toThrow(/frozen/i);

    expect(await events(batchId)).toEqual([
      expect.objectContaining({ handoff_status: 'COMPLETED', transition: 'ADVANCE' }),
      expect.objectContaining({ handoff_status: 'FAILED', transition: 'CONTRADICTION' }),
      expect.objectContaining({
        handoff_status: 'ACKNOWLEDGED',
        transition: 'FROZEN',
        applied: false,
        evidence_reference: 'receipt-4',
      }),
      expect.objectContaining({ handoff_status: 'FAILED', transition: 'FROZEN', applied: false }),
    ]);

    const frozen = await sidecar.query(
      `SELECT handoff_status, frozen_at FROM partner_handoffs WHERE sweep_batch_id = $1`,
      [batchId],
    );
    expect(frozen.rows[0].handoff_status).toBe('COMPLETED');
    expect(frozen.rows[0].frozen_at).not.toBeNull();
  });

  it('records the contradicting delivery that freezes the batch', async () => {
    const batchId = await seedBatch();
    await callback(batchId, 'COMPLETED', 'receipt-2');

    await expect(callback(batchId, 'FAILED')).rejects.toThrow(/already terminal at COMPLETED/i);

    const recorded = await events(batchId);
    expect(recorded[recorded.length - 1]).toEqual(
      expect.objectContaining({
        handoff_status: 'FAILED',
        transition: 'CONTRADICTION',
        applied: false,
      }),
    );

    const frozen = await sidecar.query(
      `SELECT frozen_at, handoff_status FROM partner_handoffs WHERE sweep_batch_id = $1`,
      [batchId],
    );
    expect(frozen.rows[0].frozen_at).not.toBeNull();
    expect(frozen.rows[0].handoff_status).toBe('COMPLETED');
  });

  it('refuses to rewrite or delete a recorded batch callback', async () => {
    const batchId = await seedBatch();
    await callback(batchId, 'SUBMITTED');

    await expect(
      sidecar.query(
        `UPDATE partner_handoff_events SET handoff_status = 'COMPLETED' WHERE sweep_batch_id = $1`,
        [batchId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sidecar.query(`DELETE FROM partner_handoff_events WHERE sweep_batch_id = $1`, [batchId]),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to record a non-advancing delivery as applied', async () => {
    const batchId = await seedBatch();

    await expect(
      sidecar.query(
        `INSERT INTO partner_handoff_events (
           sweep_batch_id, partner_name, partner_reference, handoff_status,
           transition, applied, payload_hash, observed_at
         ) VALUES ($1, 'bridge', 'ref', 'COMPLETED', 'STALE', true, $2, NOW())`,
        [batchId, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/applied_only_on_advance/);
  });
});
