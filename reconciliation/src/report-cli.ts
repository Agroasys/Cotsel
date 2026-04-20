import fs from 'node:fs';
import path from 'node:path';
import { createServicePool } from '@agroasys/shared-db';
import { Pool } from 'pg';
import { projectTreasuryAccountingState } from '@agroasys/sdk';
import {
  buildReconciliationReport,
  type ReconciliationReportInputRow,
} from './core/reconciliationReport';

const RECONCILIATION_SERVICE_NAME = 'reconciliation';
const TREASURY_SERVICE_NAME = 'treasury';

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
  amount_raw: string;
  allocated_amount_raw: string | null;
  allocation_status: string | null;
  accounting_period_key: string | null;
  accounting_period_status: string | null;
  sweep_batch_id: number | null;
  sweep_batch_status: string | null;
  matched_sweep_tx_hash: string | null;
  matched_sweep_block_number: number | null;
  matched_swept_at: Date | null;
  partner_name: string | null;
  partner_reference: string | null;
  partner_handoff_status: string | null;
  revenue_realization_status: string | null;
  realized_at: Date | null;
  ramp_reference: string | null;
  fiat_deposit_state: string | null;
  fiat_deposit_failure_class: string | null;
  fiat_deposit_observed_at: Date | null;
  bank_reference: string | null;
  bank_payout_state: string | null;
  bank_failure_code: string | null;
  bank_confirmed_at: Date | null;
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

    throw new Error(
      'Usage: ts-node src/report-cli.ts [--run-key=<runKey>] [--out=<path>] [--compact]',
    );
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
      [requestedRunKey],
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
     LIMIT 1`,
  );

  return latest.rows[0]?.run_key ?? null;
}

async function fetchDriftSummaries(pool: Pool, runKey: string): Promise<Map<string, string[]>> {
  const result = await pool.query<DriftSummaryRow>(
    `SELECT trade_id, ARRAY_AGG(DISTINCT mismatch_code ORDER BY mismatch_code) AS mismatch_codes
     FROM reconcile_drifts
     WHERE run_key = $1
     GROUP BY trade_id`,
    [runKey],
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
    [runKey],
  );

  return result.rows.map((row) => row.trade_id);
}

async function fetchTreasuryLedgerStates(
  pool: Pool,
  scopedTradeIds: string[],
): Promise<TreasuryLedgerStateRow[]> {
  if (scopedTradeIds.length === 0) {
    return [];
  }

  const result = await pool.query<TreasuryLedgerStateRow>(
    `SELECT
        e.id,
        e.trade_id,
        e.tx_hash,
        s.state AS latest_state,
        e.amount_raw,
        alloc.entry_amount_raw AS allocated_amount_raw,
        alloc.allocation_status,
        period.period_key AS accounting_period_key,
        period.status AS accounting_period_status,
        batch.id AS sweep_batch_id,
        batch.status AS sweep_batch_status,
        claim.tx_hash AS matched_sweep_tx_hash,
        claim.block_number AS matched_sweep_block_number,
        claim.observed_at AS matched_swept_at,
        handoff.partner_name,
        handoff.partner_reference,
        handoff.handoff_status AS partner_handoff_status,
        realization.realization_status AS revenue_realization_status,
        realization.realized_at,
        d.ramp_reference,
        d.deposit_state AS fiat_deposit_state,
        d.failure_class AS fiat_deposit_failure_class,
        d.observed_at AS fiat_deposit_observed_at,
        b.bank_reference,
        b.bank_state AS bank_payout_state,
        b.failure_code AS bank_failure_code,
        b.confirmed_at AS bank_confirmed_at
      FROM treasury_ledger_entries e
      JOIN LATERAL (
        SELECT p.state
        FROM payout_lifecycle_events p
        WHERE p.ledger_entry_id = e.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) s ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM sweep_batch_entries sbe
        WHERE sbe.ledger_entry_id = e.id
          AND sbe.allocation_status = 'ALLOCATED'
        ORDER BY sbe.updated_at DESC, sbe.id DESC
        LIMIT 1
      ) alloc ON TRUE
      LEFT JOIN sweep_batches batch ON batch.id = alloc.sweep_batch_id
      LEFT JOIN accounting_periods period ON period.id = batch.accounting_period_id
      LEFT JOIN treasury_claim_events claim ON claim.matched_sweep_batch_id = batch.id
      LEFT JOIN partner_handoffs handoff ON handoff.sweep_batch_id = batch.id
      LEFT JOIN LATERAL (
        SELECT r.realization_status, r.realized_at
        FROM revenue_realizations r
        WHERE r.ledger_entry_id = e.id
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) realization ON TRUE
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
      LEFT JOIN LATERAL (
        SELECT
          c.bank_reference,
          c.bank_state,
          c.failure_code,
          c.confirmed_at
        FROM bank_payout_confirmations c
        WHERE c.ledger_entry_id = e.id
        ORDER BY c.confirmed_at DESC, c.id DESC
        LIMIT 1
      ) b ON TRUE
      WHERE e.trade_id = ANY($1::text[])
      ORDER BY e.trade_id ASC, e.tx_hash ASC, e.id ASC`,
    [scopedTradeIds],
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

  const reconciliationPool = createServicePool({
    serviceName: RECONCILIATION_SERVICE_NAME,
    connectionRole: 'runtime',
    runtimeDbUser: dbUser,
    host: dbHost,
    port: dbPort,
    database: reconciliationDbName,
    user: dbUser,
    password: dbPassword,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
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
    const runTradeScope = await fetchRunTradeScope(reconciliationPool, resolvedRunKey);
    const scopeTradeIds =
      runTradeScope.length > 0
        ? runTradeScope
        : Array.from(driftByTradeId.keys()).sort((a, b) => a.localeCompare(b));

    let treasuryRows: TreasuryLedgerStateRow[] = [];
    if (treasuryDbName) {
      const treasuryDbHost = optionalEnv('TREASURY_DB_HOST') || dbHost;
      const treasuryDbPort = numberEnv('TREASURY_DB_PORT', dbPort);
      const treasuryDbUser = optionalEnv('TREASURY_DB_USER') || dbUser;
      const treasuryDbPassword = optionalEnv('TREASURY_DB_PASSWORD') || dbPassword;

      treasuryPool = createServicePool({
        serviceName: TREASURY_SERVICE_NAME,
        connectionRole: 'runtime',
        runtimeDbUser: treasuryDbUser,
        host: treasuryDbHost,
        port: treasuryDbPort,
        database: treasuryDbName,
        user: treasuryDbUser,
        password: treasuryDbPassword,
        max: 2,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 5000,
      });
      treasuryRows = await fetchTreasuryLedgerStates(treasuryPool, scopeTradeIds);
    }

    const rows: ReconciliationReportInputRow[] = treasuryRows.map((row) => {
      const accountingProjection = projectTreasuryAccountingState({
        allocationStatus: row.allocation_status as 'ALLOCATED' | 'RELEASED' | null,
        allocatedAmountRaw: row.allocated_amount_raw,
        partnerReference: row.partner_reference,
        partnerHandoffStatus: row.partner_handoff_status as
          | 'CREATED'
          | 'SUBMITTED'
          | 'ACKNOWLEDGED'
          | 'COMPLETED'
          | 'FAILED'
          | null,
        matchedSweepTxHash: row.matched_sweep_tx_hash,
        matchedSweptAt: row.matched_swept_at ? new Date(row.matched_swept_at) : null,
        latestFiatDepositState: row.fiat_deposit_state as
          | 'PENDING'
          | 'FUNDED'
          | 'PARTIAL'
          | 'REVERSED'
          | 'FAILED'
          | null,
        latestBankPayoutState: row.bank_payout_state as 'PENDING' | 'CONFIRMED' | 'REJECTED' | null,
        revenueRealizationStatus: row.revenue_realization_status as 'REALIZED' | 'REVERSED' | null,
        realizedAt: row.realized_at ? new Date(row.realized_at) : null,
      });

      return {
        tradeId: row.trade_id,
        txHash: row.tx_hash,
        payoutState: row.latest_state,
        accountingState: accountingProjection.accountingState,
        accountingStateReason: accountingProjection.accountingStateReason,
        accountingPeriodKey: row.accounting_period_key,
        accountingPeriodStatus: row.accounting_period_status,
        sweepBatchId: row.sweep_batch_id,
        sweepBatchStatus: row.sweep_batch_status,
        matchedSweepTxHash: row.matched_sweep_tx_hash,
        matchedSweptAt: row.matched_swept_at ? new Date(row.matched_swept_at) : null,
        partnerName: row.partner_name,
        partnerReference: row.partner_reference,
        partnerHandoffStatus: row.partner_handoff_status,
        realizedAt: row.realized_at ? new Date(row.realized_at) : null,
        rampReference: row.ramp_reference,
        fiatDepositState: row.fiat_deposit_state,
        fiatDepositFailureClass: row.fiat_deposit_failure_class,
        fiatDepositObservedAt: row.fiat_deposit_observed_at
          ? new Date(row.fiat_deposit_observed_at)
          : null,
        bankReference: row.bank_reference,
        bankPayoutState: row.bank_payout_state,
        bankFailureCode: row.bank_failure_code,
        bankConfirmedAt: row.bank_confirmed_at ? new Date(row.bank_confirmed_at) : null,
        mismatchCodes: driftByTradeId.get(row.trade_id) || [],
        ledgerEntryId: row.id,
        allocatedAmountRaw: row.allocated_amount_raw,
        sourceAmountRaw: row.amount_raw,
      };
    });

    const seenTradeIds = new Set(rows.map((row) => row.tradeId));
    for (const tradeId of scopeTradeIds) {
      if (seenTradeIds.has(tradeId)) {
        continue;
      }

      rows.push({
        tradeId,
        txHash: null,
        payoutState: null,
        accountingState: null,
        accountingStateReason: null,
        accountingPeriodKey: null,
        accountingPeriodStatus: null,
        sweepBatchId: null,
        sweepBatchStatus: null,
        matchedSweepTxHash: null,
        matchedSweptAt: null,
        partnerName: null,
        partnerReference: null,
        partnerHandoffStatus: null,
        realizedAt: null,
        rampReference: null,
        fiatDepositState: null,
        fiatDepositFailureClass: null,
        fiatDepositObservedAt: null,
        bankReference: null,
        bankPayoutState: null,
        bankFailureCode: null,
        bankConfirmedAt: null,
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
        payoutState: null,
        accountingState: null,
        accountingStateReason: null,
        accountingPeriodKey: null,
        accountingPeriodStatus: null,
        sweepBatchId: null,
        sweepBatchStatus: null,
        matchedSweepTxHash: null,
        matchedSweptAt: null,
        partnerName: null,
        partnerReference: null,
        partnerHandoffStatus: null,
        realizedAt: null,
        rampReference: null,
        fiatDepositState: null,
        fiatDepositFailureClass: null,
        fiatDepositObservedAt: null,
        bankReference: null,
        bankPayoutState: null,
        bankFailureCode: null,
        bankConfirmedAt: null,
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
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: failed to generate reconciliation report: ${message}`);
  process.exit(1);
});
