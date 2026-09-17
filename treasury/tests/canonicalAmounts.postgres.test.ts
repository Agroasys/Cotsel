import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * The domains and the allocation trigger are database-level guarantees. A mock
 * cannot prove them, so these run only against a real PostgreSQL instance —
 * the same gate `partnerHandoff.postgres.test.ts` uses.
 */
const runPostgresIntegrationTests = process.env.TREASURY_POSTGRES_TESTS === 'true';
const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

const host = process.env.DB_HOST || '127.0.0.1';
const port = Number(process.env.DB_PORT || 5432);
const user = process.env.DB_USER || 'postgres';
const password = process.env.DB_PASSWORD || 'postgres';

describePostgres('treasury canonical monetary amount constraints', () => {
  let dbName: string;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    dbName = `treasury_canonical_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    admin = new Pool({ host, port, database: 'postgres', user, password });
    await admin.query(`CREATE DATABASE "${dbName}"`);

    pool = new Pool({ host, port, database: dbName, user, password });
    const databaseDir = resolve(__dirname, '../src/database');
    await pool.query(readFileSync(resolve(databaseDir, 'schema.sql'), 'utf8'));
    await pool.query(
      readFileSync(resolve(databaseDir, '002_canonical_monetary_amounts.sql'), 'utf8'),
    );
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin?.end();
  }, 60000);

  async function insertLedgerEntry(amountRaw: string, suffix: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO treasury_ledger_entries (
         entry_key, trade_id, tx_hash, block_number, event_name,
         component_type, amount_raw, source_timestamp
       ) VALUES ($1, $2, $3, 100, 'PlatformFeesPaidStage1', 'PLATFORM_FEE', $4, NOW())
       RETURNING id`,
      [`entry-${suffix}`, `trade-${suffix}`, `0xtx-${suffix}`, amountRaw],
    );
    return result.rows[0].id;
  }

  describe('treasury_raw_amount domain', () => {
    it.each(['0', '1', '4000000', '9007199254740993'])('accepts canonical %s', async (amount) => {
      await expect(insertLedgerEntry(amount, `ok-${amount}`)).resolves.toBeGreaterThan(0);
    });

    it.each([
      ['empty string', ''],
      ['leading zero', '007'],
      ['negative', '-1'],
      ['decimal', '1.5'],
      ['exponent', '1e6'],
      ['whitespace', ' 100'],
      ['non-numeric', 'NaN'],
    ])('rejects %s', async (label, amount) => {
      await expect(insertLedgerEntry(amount, `bad-${label}`)).rejects.toThrow(
        /treasury_raw_amount_is_canonical|invalid input syntax/,
      );
    });

    it('rejects a value above the uint256 range', async () => {
      const aboveMax = (2n ** 256n).toString();
      await expect(insertLedgerEntry(aboveMax, 'above-max')).rejects.toThrow(
        /treasury_raw_amount_is_canonical/,
      );
    });
  });

  describe('treasury_fiat_amount domain', () => {
    async function insertHandoffAmount(amount: string, suffix: string): Promise<void> {
      const ledgerEntryId = await insertLedgerEntry('1000', `fiat-${suffix}`);
      await pool.query(
        `INSERT INTO treasury_partner_handoffs (
           ledger_entry_id, partner_code, handoff_reference, partner_status,
           source_amount, source_currency, actor, latest_event_payload_hash, initiated_at
         ) VALUES ($1, 'bridge', $2, 'SUBMITTED', $3, 'USD', 'ops', repeat('a', 64), NOW())`,
        [ledgerEntryId, `handoff-${suffix}`, amount],
      );
    }

    it.each(['125.00', '100', '0.5', '0'])(
      'accepts the provider-reported amount %s',
      async (amount) => {
        await expect(insertHandoffAmount(amount, `ok-${amount}`)).resolves.toBeUndefined();
      },
    );

    it.each([
      ['negative', '-125.00'],
      ['leading zero', '0100'],
      ['trailing separator', '125.'],
      ['too many fractional digits', '1.123456789'],
    ])('rejects %s', async (label, amount) => {
      await expect(insertHandoffAmount(amount, `bad-${label}`)).rejects.toThrow(
        /treasury_fiat_amount_is_canonical/,
      );
    });
  });

  describe('sweep allocation bound trigger', () => {
    let ledgerEntryId: number;
    let batchId: number;

    beforeAll(async () => {
      ledgerEntryId = await insertLedgerEntry('1000', 'alloc');
      const period = await pool.query<{ id: number }>(
        `INSERT INTO accounting_periods (period_key, starts_at, ends_at, status, created_by)
         VALUES ('2026-09', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 'OPEN', 'ops')
         RETURNING id`,
      );
      const batch = await pool.query<{ id: number }>(
        `INSERT INTO sweep_batches (
           batch_key, accounting_period_id, asset_symbol, status, expected_total_raw, created_by
         ) VALUES ('batch-1', $1, 'USDC', 'DRAFT', '1000', 'ops')
         RETURNING id`,
        [period.rows[0].id],
      );
      batchId = batch.rows[0].id;
    });

    async function allocate(amountRaw: string, status = 'ALLOCATED'): Promise<void> {
      await pool.query(
        `INSERT INTO sweep_batch_entries (
           sweep_batch_id, ledger_entry_id, allocation_status, entry_amount_raw, allocated_by
         ) VALUES ($1, $2, $3, $4, 'ops')`,
        [batchId, ledgerEntryId, status, amountRaw],
      );
    }

    it('rejects an allocation larger than the eligible ledger amount', async () => {
      await expect(allocate('1001')).rejects.toThrow(/exceeds the eligible ledger amount/);
    });

    it('rejects a zero allocation', async () => {
      await expect(allocate('0')).rejects.toThrow(/must be greater than zero/);
    });

    it('accepts a partial allocation within the ledger amount', async () => {
      await expect(allocate('250', 'RELEASED')).resolves.toBeUndefined();
      await expect(allocate('750')).resolves.toBeUndefined();
    });
  });
});
