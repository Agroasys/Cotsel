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

interface RunTradeScopeRow {
  trade_id: string;
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
  ramp_reference: string | null;
  fiat_deposit_state: string | null;
  fiat_deposit_failure_class: string | null;
  fiat_deposit_observed_at: Date | null;
}

interface IndexerHashRow {
  tx_hash: string;
  extrinsic_hash: string | null;
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

async function fetchRunTradeScope(pool: Pool, runKey: string): Promise<string[]> {
  const result = await pool.query<RunTradeScopeRow>(
    `SELECT trade_id
     FROM reconcile_run_trades
     WHERE run_key = $1
     ORDER BY trade_id ASC`,
    [runKey]
  );

  return result.rows.map((row) => row.trade_id);
}

async function fetchTreasuryLedgerStates(pool: Pool, scopedTradeIds: string[]): Promise<TreasuryLedgerStateRow[]> {
  if (scopedTradeIds.length === 0) {
    return [];
  }

  const result = await pool.query<TreasuryLedgerStateRow>(
    `SELECT
        e.id,
        e.trade_id,
        e.tx_hash,
        s.state AS latest_state,
        d.ramp_reference,
        d.deposit_state AS fiat_deposit_state,
        d.failure_class AS fiat_deposit_failure_class,
        d.observed_at AS fiat_deposit_observed_at
      FROM treasury_ledger_entries e
      JOIN LATERAL (
        SELECT p.state
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) s ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          r.ramp_reference,
          r.deposit_state,
          r.failure_class,
          r.observed_at
        FROM fiat_deposit_references r
        WHERE r.ledger_entry_id = e.id
           OR (r.ledger_entry_id IS NULL AND r.trade_id = e.trade_id)
        ORDER BY CASE WHEN r.ledger_entry_id = e.id THEN 0 ELSE 1 END, r.observed_at DESC, r.id DESC
        LIMIT 1
      ) d ON TRUE
      WHERE e.trade_id = ANY($1::text[])
      ORDER BY e.trade_id ASC, e.tx_hash ASC, e.id ASC`
    ,
    [scopedTradeIds]
  );

  return result.rows;
}

async function fetchIndexerExtrinsicHashes(pool: Pool, txHashes: string[]): Promise<Map<string, string | null>> {
  if (txHashes.length === 0) {
    return new Map();
  }

  const result = await pool.query<IndexerHashRow>(
    `SELECT tx_hash, MAX(extrinsic_hash) AS extrinsic_hash
     FROM trade_event
     WHERE tx_hash = ANY($1::text[])
     GROUP BY tx_hash`,
    [txHashes]
  );

  const map = new Map<string, string | null>();
  for (const row of result.rows) {
    map.set(row.tx_hash, row.extrinsic_hash ?? null);
  }
  return map;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const dbHost = requiredEnv('DB_HOST');
  const dbPort = numberEnv('DB_PORT');
  const dbUser = requiredEnv('DB_USER');
  const dbPassword = requiredEnv('DB_PASSWORD');
  const reconciliationDbName = requiredEnv('DB_NAME');
  const treasuryDbName = optionalEnv('TREASURY_DB_NAME');
  const indexerDbName = optionalEnv('INDEXER_DB_NAME');

  const reconciliationPool = new Pool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: reconciliationDbName,
    max: 2,
  });

  let treasuryPool: Pool | null = null;
  let indexerPool: Pool | null = null;

  try {
    const resolvedRunKey = await resolveRunKey(reconciliationPool, args.runKey);
    if (!resolvedRunKey) {
      const emptyReport = buildReconciliationReport(null, []);
      writeReport(args.outPath, emptyReport, args.pretty);
      return;
    }

    const driftByTradeId = await fetchDriftSummaries(reconciliationPool, resolvedRunKey);
    const runTradeScope = await fetchRunTradeScope(reconciliationPool, resolvedRunKey);
    const scopeTradeIds =
      runTradeScope.length > 0
        ? runTradeScope
        : Array.from(driftByTradeId.keys()).sort((a, b) => a.localeCompare(b));

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
      treasuryRows = await fetchTreasuryLedgerStates(treasuryPool, scopeTradeIds);
    }

    let extrinsicHashByTxHash = new Map<string, string | null>();
    if (indexerDbName) {
      const txHashes = Array.from(new Set(treasuryRows.map((row) => row.tx_hash)));
      indexerPool = new Pool({
        host: optionalEnv('INDEXER_DB_HOST') || dbHost,
        port: numberEnv('INDEXER_DB_PORT', dbPort),
        user: optionalEnv('INDEXER_DB_USER') || dbUser,
        password: optionalEnv('INDEXER_DB_PASSWORD') || dbPassword,
        database: indexerDbName,
        max: 2,
      });
      extrinsicHashByTxHash = await fetchIndexerExtrinsicHashes(indexerPool, txHashes);
    }

    const rows: ReconciliationReportInputRow[] = treasuryRows.map((row) => ({
      tradeId: row.trade_id,
      txHash: row.tx_hash,
      extrinsicHash: extrinsicHashByTxHash.get(row.tx_hash) ?? null,
      payoutState: row.latest_state,
      rampReference: row.ramp_reference,
      fiatDepositState: row.fiat_deposit_state,
      fiatDepositFailureClass: row.fiat_deposit_failure_class,
      fiatDepositObservedAt: row.fiat_deposit_observed_at ? new Date(row.fiat_deposit_observed_at) : null,
      mismatchCodes: driftByTradeId.get(row.trade_id) || [],
      ledgerEntryId: row.id,
    }));

    const seenTradeIds = new Set(rows.map((row) => row.tradeId));
    for (const tradeId of scopeTradeIds) {
      if (seenTradeIds.has(tradeId)) {
        continue;
      }

      rows.push({
        tradeId,
        txHash: null,
        extrinsicHash: null,
        payoutState: null,
        rampReference: null,
        fiatDepositState: null,
        fiatDepositFailureClass: null,
        fiatDepositObservedAt: null,
        mismatchCodes: driftByTradeId.get(tradeId) || [],
        ledgerEntryId: null,
      });
      seenTradeIds.add(tradeId);
    }

    for (const [tradeId, mismatchCodes] of driftByTradeId.entries()) {
      if (seenTradeIds.has(tradeId)) {
        continue;
      }

      rows.push({
        tradeId,
        txHash: null,
        extrinsicHash: null,
        payoutState: null,
        rampReference: null,
        fiatDepositState: null,
        fiatDepositFailureClass: null,
        fiatDepositObservedAt: null,
        mismatchCodes,
        ledgerEntryId: null,
      });
      seenTradeIds.add(tradeId);
    }

    const report = buildReconciliationReport(resolvedRunKey, rows);
    writeReport(args.outPath, report, args.pretty);
  } finally {
    await reconciliationPool.end();
    if (treasuryPool) {
      await treasuryPool.end();
    }
    if (indexerPool) {
      await indexerPool.end();
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: failed to generate reconciliation report: ${message}`);
  process.exit(1);
});
