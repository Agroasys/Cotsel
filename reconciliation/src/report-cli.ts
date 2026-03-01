import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { buildReconciliationReport, type ReconciliationReportInputRow } from './core/reconciliationReport';

interface CliArgs {
  runKey?: string;
  outPath?: string;
  pretty: boolean;
}

interface RunRow {
  run_key: string;
}

interface DriftSummaryRow {
  trade_id: string;
  mismatch_codes: string[];
}

interface TreasuryLedgerStateRow {
  id: number;
  trade_id: string;
  tx_hash: string;
  latest_state: string;
}

function parseArgs(argv: string[]): CliArgs {
  let runKey: string | undefined;
  let outPath: string | undefined;
  let pretty = true;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--run-key=')) {
      runKey = arg.replace('--run-key=', '');
      continue;
    }

    if (arg.startsWith('--out=')) {
      outPath = arg.replace('--out=', '');
      continue;
    }

    if (arg === '--compact') {
      pretty = false;
      continue;
    }

    throw new Error('Usage: ts-node src/report-cli.ts [--run-key=<runKey>] [--out=<path>] [--compact]');
  }

  return {
    runKey,
    outPath,
    pretty,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for reconciliation report generation`);
  }
  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberEnv(name: string, fallback?: number): number {
  const raw = optionalEnv(name);
  if (!raw) {
    if (fallback === undefined) {
      throw new Error(`${name} is required`);
    }
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a number`);
  }

  return parsed;
}

function writeReport(outPath: string | undefined, payload: object, pretty: boolean): void {
  const serialized = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);

  if (!outPath) {
    process.stdout.write(`${serialized}\n`);
    return;
  }

  const absolute = path.resolve(outPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${serialized}\n`, 'utf8');
}

async function resolveRunKey(pool: Pool, requestedRunKey?: string): Promise<string | null> {
  if (requestedRunKey) {
    const run = await pool.query<RunRow>(
      `SELECT run_key
       FROM reconcile_runs
       WHERE run_key = $1`,
      [requestedRunKey]
    );

    if (!run.rows[0]) {
      throw new Error(`run_key not found: ${requestedRunKey}`);
    }

    return run.rows[0].run_key;
  }

  const latest = await pool.query<RunRow>(
    `SELECT run_key
     FROM reconcile_runs
     WHERE status = 'COMPLETED'
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`
  );

  return latest.rows[0]?.run_key ?? null;
}

async function fetchDriftSummaries(pool: Pool, runKey: string): Promise<Map<string, string[]>> {
  const result = await pool.query<DriftSummaryRow>(
    `SELECT trade_id, ARRAY_AGG(DISTINCT mismatch_code ORDER BY mismatch_code) AS mismatch_codes
     FROM reconcile_drifts
     WHERE run_key = $1
     GROUP BY trade_id`,
    [runKey]
  );

  const map = new Map<string, string[]>();
  for (const row of result.rows) {
    map.set(row.trade_id, row.mismatch_codes || []);
  }

  return map;
}

async function fetchTreasuryLedgerStates(pool: Pool): Promise<TreasuryLedgerStateRow[]> {
  const result = await pool.query<TreasuryLedgerStateRow>(
    `SELECT
        e.id,
        e.trade_id,
        e.tx_hash,
        s.state AS latest_state
      FROM treasury_ledger_entries e
      JOIN LATERAL (
        SELECT p.state
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) s ON TRUE
      ORDER BY e.trade_id ASC, e.tx_hash ASC, e.id ASC`
  );

  return result.rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const dbHost = requiredEnv('DB_HOST');
  const dbPort = numberEnv('DB_PORT');
  const dbUser = requiredEnv('DB_USER');
  const dbPassword = requiredEnv('DB_PASSWORD');
  const reconciliationDbName = requiredEnv('DB_NAME');
  const treasuryDbName = optionalEnv('TREASURY_DB_NAME');

  const reconciliationPool = new Pool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: reconciliationDbName,
    max: 2,
  });

  let treasuryPool: Pool | null = null;

  try {
    const resolvedRunKey = await resolveRunKey(reconciliationPool, args.runKey);
    if (!resolvedRunKey) {
      const emptyReport = buildReconciliationReport(null, []);
      writeReport(args.outPath, emptyReport, args.pretty);
      return;
    }

    const driftByTradeId = await fetchDriftSummaries(reconciliationPool, resolvedRunKey);

    let treasuryRows: TreasuryLedgerStateRow[] = [];
    if (treasuryDbName) {
      treasuryPool = new Pool({
        host: optionalEnv('TREASURY_DB_HOST') || dbHost,
        port: numberEnv('TREASURY_DB_PORT', dbPort),
        user: optionalEnv('TREASURY_DB_USER') || dbUser,
        password: optionalEnv('TREASURY_DB_PASSWORD') || dbPassword,
        database: treasuryDbName,
        max: 2,
      });
      treasuryRows = await fetchTreasuryLedgerStates(treasuryPool);
    }

    const rows: ReconciliationReportInputRow[] = treasuryRows.map((row) => ({
      tradeId: row.trade_id,
      txHash: row.tx_hash,
      extrinsicHash: null,
      payoutState: row.latest_state,
      mismatchCodes: driftByTradeId.get(row.trade_id) || [],
      ledgerEntryId: row.id,
    }));

    const seenTradeIds = new Set(rows.map((row) => row.tradeId));
    for (const [tradeId, mismatchCodes] of driftByTradeId.entries()) {
      if (seenTradeIds.has(tradeId)) {
        continue;
      }

      rows.push({
        tradeId,
        txHash: null,
        extrinsicHash: null,
        payoutState: null,
        mismatchCodes,
        ledgerEntryId: null,
      });
    }

    const report = buildReconciliationReport(resolvedRunKey, rows);
    writeReport(args.outPath, report, args.pretty);
  } finally {
    await reconciliationPool.end();
    if (treasuryPool) {
      await treasuryPool.end();
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: failed to generate reconciliation report: ${message}`);
  process.exit(1);
});
