import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * The export's completeness claim is that summing `scannedRowCount` across pages
 * equals `snapshot.rowCount`. That only holds if the snapshot query and the page
 * query define "candidate" identically, which is a property of the SQL and needs
 * a real database to prove.
 */
const runPostgresIntegrationTests = process.env.TREASURY_POSTGRES_TESTS === 'true';
const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

const host = process.env.DB_HOST || '127.0.0.1';
const port = Number(process.env.DB_PORT || 5432);
const user = process.env.DB_USER || 'postgres';
const password = process.env.DB_PASSWORD || 'postgres';

describePostgres('treasury ledger export coverage', () => {
  let dbName: string;
  let admin: Pool;
  let pool: Pool;
  let queries: typeof import('../src/database/queries/ledger');
  let loadExportPage: typeof import('../src/core/ledgerExportService').loadLedgerExportPage;
  let parseExportRequest: typeof import('../src/core/ledgerExport').parseExportRequest;

  beforeAll(async () => {
    dbName = `treasury_export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    admin = new Pool({ host, port, database: 'postgres', user, password });
    await admin.query(`CREATE DATABASE "${dbName}"`);

    // `connection.ts` loads `config.ts` at import time, so the full required
    // environment must exist before the queries module is imported below.
    process.env.PORT = process.env.PORT || '3201';
    process.env.DB_HOST = host;
    process.env.DB_PORT = String(port);
    process.env.DB_NAME = dbName;
    process.env.DB_USER = user;
    process.env.DB_PASSWORD = password;
    process.env.INDEXER_GRAPHQL_URL =
      process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

    pool = new Pool({ host, port, database: dbName, user, password });
    const databaseDir = resolve(__dirname, '../src/database');
    await pool.query(readFileSync(resolve(databaseDir, 'schema.sql'), 'utf8'));
    await pool.query(
      readFileSync(resolve(databaseDir, '002_canonical_monetary_amounts.sql'), 'utf8'),
    );

    queries = await import('../src/database/queries/ledger');
    ({ loadLedgerExportPage: loadExportPage } = await import('../src/core/ledgerExportService'));
    ({ parseExportRequest } = await import('../src/core/ledgerExport'));
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    const connection = await import('../src/database/connection');
    await connection.pool?.end().catch(() => undefined);
    await admin?.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin?.end();
  }, 60000);

  // Explicit timestamps keep cutoff behavior independent of host/database clock skew.
  const cutoff = new Date('2026-01-01T00:00:00.000Z');

  async function insertEntry(
    suffix: string,
    withPayoutEvent: boolean,
    createdAt: Date = cutoff,
  ): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO treasury_ledger_entries (
         entry_key, trade_id, tx_hash, block_number, event_name,
         component_type, amount_raw, source_timestamp, created_at
       ) VALUES ($1, $2, $3, 100, 'PlatformFeesPaidStage1', 'PLATFORM_FEE', '1000', $4, $4)
       RETURNING id`,
      [`export-${suffix}`, `trade-${suffix}`, `0xtx-${suffix}`, createdAt],
    );
    const id = result.rows[0].id;

    if (withPayoutEvent) {
      await pool.query(
        `INSERT INTO payout_lifecycle_events (ledger_entry_id, state, actor)
         VALUES ($1, 'READY_FOR_EXTERNAL_HANDOFF', 'ops')`,
        [id],
      );
    }

    return id;
  }

  it('enumerates an entry that has no payout lifecycle event', async () => {
    const orphanId = await insertEntry('orphan', false);
    await insertEntry('normal', true);

    const snapshot = await queries.getLedgerExportSnapshot(cutoff);
    const page = await queries.getLedgerEntriesForExport({ cutoff, cursor: null, limit: 100 });

    expect(snapshot.rowCount).toBe(2);
    expect(page.entries).toHaveLength(2);
    expect(page.hasMore).toBe(false);

    const orphan = page.entries.find((entry) => entry.id === orphanId);
    expect(orphan).toBeDefined();
    // It is enumerated so the pages reconcile, but carries no state, so the
    // eligibility gate can never mark it exportable.
    expect(orphan?.latest_state).toBeNull();
  });

  it('scans every candidate exactly once across keyset pages', async () => {
    const snapshot = await queries.getLedgerExportSnapshot(cutoff);

    const seen: number[] = [];
    let cursor: { createdAt: Date; id: number } | null = null;
    let scanned = 0;

    for (let guard = 0; guard < 20; guard += 1) {
      const page = await queries.getLedgerEntriesForExport({ cutoff, cursor, limit: 1 });
      scanned += page.entries.length;
      seen.push(...page.entries.map((entry) => entry.id));
      if (!page.hasMore) break;
      const last = page.entries[page.entries.length - 1];
      cursor = { createdAt: new Date(last.created_at), id: last.id };
    }

    expect(scanned).toBe(snapshot.rowCount);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('excludes rows created after the cutoff', async () => {
    const before = await queries.getLedgerExportSnapshot(cutoff);
    await insertEntry('after-cutoff', true, new Date(cutoff.getTime() + 1));
    const after = await queries.getLedgerExportSnapshot(cutoff);
    const page = await queries.getLedgerEntriesForExport({ cutoff, cursor: null, limit: 100 });

    expect(after.rowCount).toBe(before.rowCount);
    expect(page.entries).toHaveLength(before.rowCount);
  });

  it('enumerates more than 5,000 database rows exactly once under one cutoff', async () => {
    const before = await queries.getLedgerExportSnapshot(cutoff);
    await pool.query(
      `INSERT INTO treasury_ledger_entries (
         entry_key, trade_id, tx_hash, block_number, event_name,
         component_type, amount_raw, source_timestamp, created_at
       )
       SELECT 'export-bulk-' || n, 'trade-bulk-' || n, '0xtx-bulk-' || n,
              100, 'PlatformFeesPaidStage1', 'PLATFORM_FEE', '1', $1, $1
       FROM generate_series(1, 5001) AS n`,
      [cutoff],
    );

    const snapshot = await queries.getLedgerExportSnapshot(cutoff);
    expect(snapshot.rowCount).toBe(before.rowCount + 5001);
    expect(BigInt(snapshot.totalAmountRaw)).toBe(BigInt(before.totalAmountRaw) + 5001n);

    const seen = new Set<number>();
    let cursor: { createdAt: Date; id: number } | null = null;
    let scanned = 0;
    let scannedAmount = 0n;
    let pages = 0;

    for (; pages < 7; pages += 1) {
      const page = await queries.getLedgerEntriesForExport({ cutoff, cursor, limit: 1000 });
      for (const entry of page.entries) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
        scannedAmount += BigInt(entry.amount_raw);
      }
      scanned += page.entries.length;

      if (!page.hasMore) break;
      const last = page.entries[page.entries.length - 1];
      cursor = { createdAt: new Date(last.created_at), id: last.id };
    }

    expect(pages).toBe(5);
    expect(scanned).toBe(snapshot.rowCount);
    expect(seen.size).toBe(snapshot.rowCount);
    expect(scannedAmount).toBe(BigInt(snapshot.totalAmountRaw));
  });

  it('refuses a continuation after a pre-cutoff transaction commits between pages', async () => {
    const writer = await pool.connect();
    let committed = false;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO treasury_ledger_entries (
           entry_key, trade_id, tx_hash, block_number, event_name,
           component_type, amount_raw, source_timestamp, created_at
         ) VALUES ('export-late-commit', 'trade-late-commit', '0xtx-late-commit',
                   100, 'PlatformFeesPaidStage1', 'PLATFORM_FEE', '1', NOW(), NOW())`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const exportCutoff = new Date();
      const first = await loadExportPage(
        parseExportRequest({ cutoff: exportCutoff.toISOString(), limit: '1' }),
        async (entries) => entries.map((entry) => ({ ...entry, eligibleForExport: true })),
      );
      expect(first.nextCursor).not.toBeNull();

      await writer.query('COMMIT');
      committed = true;

      const continuation = parseExportRequest({
        cutoff: exportCutoff.toISOString(),
        cursor: first.nextCursor,
        limit: '1',
      });
      await expect(
        loadExportPage(continuation, async (entries) =>
          entries.map((entry) => ({ ...entry, eligibleForExport: true })),
        ),
      ).rejects.toThrow(/snapshot changed/);
    } finally {
      if (!committed) await writer.query('ROLLBACK');
      writer.release();
    }
  });
});
