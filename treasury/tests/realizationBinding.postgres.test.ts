/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-25 acceptance drill, against a real PostgreSQL instance.
 *
 * The claim under test is that a realization row cannot assert reconciliation
 * coverage it does not have. The application refuses first, but the constraint
 * is what makes the claim non-forgeable by a repair session or a future
 * migration, so it is exercised directly.
 */
import { Pool } from 'pg';
import {
  applyTreasuryTestEnv,
  provisionTreasuryDatabase,
  runPostgresIntegrationTests,
} from './helpers/treasuryPostgres';

const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

describePostgres('realization reconciliation binding (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let sidecar: Pool;
  let periodId: number;
  let sequence = 0;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_realization_binding');
    cleanup = provisioned.cleanup;
    applyTreasuryTestEnv(provisioned.dbName);

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
    await cleanup?.();
  });

  async function seedEntry(blockNumber: number): Promise<number> {
    sequence += 1;
    const entry = await sidecar.query<{ id: number }>(
      `INSERT INTO treasury_ledger_entries (
         entry_key, trade_id, tx_hash, block_number, event_name,
         component_type, amount_raw, source_timestamp
       )
       VALUES ($1, $2, $3, $4, 'PlatformFeesPaidStage1', 'PLATFORM_FEE', '1000', NOW())
       RETURNING id`,
      [`binding-${sequence}`, `trade-binding-${sequence}`, `0xbinding${sequence}`, blockNumber],
    );
    return entry.rows[0].id;
  }

  function insertRealization(
    entryId: number,
    binding: {
      runKey: string | null;
      coverageToBlock: number | null;
      entryBlockNumber: number | null;
    },
  ) {
    return sidecar.query(
      `INSERT INTO revenue_realizations (
         ledger_entry_id, accounting_period_id, realization_status, realized_at,
         recognized_by, reconciliation_run_key, reconciliation_coverage_to_block, entry_block_number
       )
       VALUES ($1, $2, 'REALIZED', NOW(), 'test', $3, $4, $5)`,
      [entryId, periodId, binding.runKey, binding.coverageToBlock, binding.entryBlockNumber],
    );
  }

  it('accepts a realization whose run reached the entry block', async () => {
    const entryId = await seedEntry(900);

    await expect(
      insertRealization(entryId, {
        runKey: 'run-1',
        coverageToBlock: 1000,
        entryBlockNumber: 900,
      }),
    ).resolves.toBeDefined();
  });

  it('accepts a realization sitting exactly on the watermark', async () => {
    const entryId = await seedEntry(1000);

    await expect(
      insertRealization(entryId, {
        runKey: 'run-2',
        coverageToBlock: 1000,
        entryBlockNumber: 1000,
      }),
    ).resolves.toBeDefined();
  });

  /**
   * The finding: a run that stopped below the entry is not evidence about it,
   * however fresh and drift-free the run itself was.
   */
  it('refuses a realization whose run stopped below the entry block', async () => {
    const entryId = await seedEntry(1200);

    await expect(
      insertRealization(entryId, {
        runKey: 'run-3',
        coverageToBlock: 1000,
        entryBlockNumber: 1200,
      }),
    ).rejects.toThrow(/reconciliation_binding_complete/);
  });

  it('refuses a run citation that does not say how far the run reached', async () => {
    const entryId = await seedEntry(800);

    await expect(
      insertRealization(entryId, {
        runKey: 'run-4',
        coverageToBlock: null,
        entryBlockNumber: 800,
      }),
    ).rejects.toThrow(/reconciliation_binding_complete/);
  });

  it('refuses a watermark that names no run', async () => {
    const entryId = await seedEntry(800);

    await expect(
      insertRealization(entryId, {
        runKey: null,
        coverageToBlock: 1000,
        entryBlockNumber: 800,
      }),
    ).rejects.toThrow(/reconciliation_binding_complete/);
  });

  /**
   * Rows written before this control exist and cannot be retrofitted with
   * evidence nobody recorded. All three columns NULL is the shape that says so;
   * the evidence bundle can find them by exactly that.
   */
  it('still accepts a pre-control realization carrying no binding at all', async () => {
    const entryId = await seedEntry(800);

    await expect(
      insertRealization(entryId, {
        runKey: null,
        coverageToBlock: null,
        entryBlockNumber: null,
      }),
    ).resolves.toBeDefined();
  });
});
