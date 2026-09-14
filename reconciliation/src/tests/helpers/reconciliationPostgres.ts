// Must come first: the database modules below load src/config.ts on import,
// which asserts a complete configuration before any test body runs.
import './reconciliationEnv';
import path from 'node:path';
import { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import { claimRun } from '../../database/leases';
import {
  openContainment,
  recordCleanReconciliation,
  recordPauseObservation,
} from '../../database/containments';
import { DEFAULT_SEVERITY_COUNTS } from '../../core/runOutcome';
import type {
  ClaimedRun,
  CoverageBoundary,
  DriftFinding,
  GovernedUnpauseEvidence,
  ReconcileRunRow,
  RunClaim,
  RunStats,
  TradeContainmentRow,
  TradePauseObservation,
} from '../../types';

// postgres-test-support is untyped CommonJS test tooling, not part of the
// shared-db public type surface.
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('../../../../shared-db/postgres-test-support');
/* eslint-enable @typescript-eslint/no-require-imports */

export { createAdminPool, dockerAvailable, withPostgresContainer };

export const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'database', 'migrations.json');
export const RUNTIME_ROLE = 'cotsel_reconciliation_runtime';
export const TTL_MS = 60_000;

export interface AdminPool {
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

function servicePool(port: number, database: string): Pool {
  return new Pool({
    host: '127.0.0.1',
    port,
    database,
    user: 'postgres',
    password: 'postgres',
    max: 8,
    // RLS on every reconcile table keys off this setting.
    options: `-c app.service_name=reconciliation -c app.runtime_db_user=${RUNTIME_ROLE}`,
  });
}

/**
 * Runs each scenario against a freshly migrated database inside one shared
 * container.
 *
 * A container per scenario would mean dozens of Postgres starts, which
 * dominates the suite's runtime and its Docker footprint. A database per
 * scenario gives the same isolation for the cost of a CREATE. `prefix` keeps
 * two test files sharing a container from colliding on database names.
 */
export function scenarioRunner(
  t: TestContext,
  port: number,
  admin: AdminPool,
  prefix: string,
): (name: string, fn: (pool: Pool) => Promise<void>) => Promise<void> {
  let sequence = 0;

  return async (name, fn) => {
    sequence += 1;
    const database = `cotsel_reconciliation_${prefix}_${sequence}`;

    await t.test(name, async () => {
      await admin.query(`CREATE DATABASE ${database}`);
      const pool = servicePool(port, database);
      try {
        await runVersionedMigrations({
          pool,
          serviceName: 'reconciliation',
          manifestPath: MANIFEST_PATH,
          runtimeDbUser: RUNTIME_ROLE,
        });
        await fn(pool);
      } finally {
        await pool.end();
      }
    });
  };
}

/** Age a lease past its expiry without making the test wait out a TTL. */
export async function expireLease(pool: Pool, runKey: string): Promise<void> {
  await pool.query(
    `UPDATE reconcile_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE run_key = $1`,
    [runKey],
  );
}

export async function readRun(pool: Pool, runKey: string): Promise<ReconcileRunRow> {
  const result = await pool.query<ReconcileRunRow>(
    'SELECT * FROM reconcile_runs WHERE run_key = $1',
    [runKey],
  );
  return result.rows[0];
}

export async function leaseEvents(pool: Pool, runKey: string): Promise<string[]> {
  const result = await pool.query<{ event: string }>(
    'SELECT event FROM reconcile_run_lease_events WHERE run_key = $1 ORDER BY id',
    [runKey],
  );
  return result.rows.map((row) => row.event);
}

export function stats(runKey: string, status: RunStats['status'] = 'COMPLETED'): RunStats {
  return {
    runKey,
    mode: 'DAEMON',
    status,
    totalTrades: 3,
    driftCount: 0,
    severityCounts: { ...DEFAULT_SEVERITY_COUNTS },
  };
}

export const BOUNDARY: CoverageBoundary = {
  blockNumber: 4242,
  blockHash: '0xboundary',
  tag: 'finalized',
  chainTradeCounter: 9n,
  indexerProcessedBlock: 4242,
  finalityBlockNumber: 4242,
  indexerAhead: false,
};

export function amountDrift(tradeId: string): DriftFinding {
  return {
    tradeId,
    severity: 'CRITICAL',
    mismatchCode: 'AMOUNT_MISMATCH',
    comparedField: 'totalAmountLocked',
    onchainValue: '100',
    indexedValue: '101',
    details: {},
  };
}

export function pausedAt(tradeId: string, paused = true): TradePauseObservation {
  return { tradeId, paused, blockNumber: BOUNDARY.blockNumber, readError: null };
}

/** A governed unpause that satisfies every rule, so a test can vary one field. */
export function approval(
  overrides: Partial<GovernedUnpauseEvidence> = {},
): GovernedUnpauseEvidence {
  return {
    txHash: '0x' + 'ab'.repeat(32),
    chainId: 84532,
    contractAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    tradeId: '7',
    blockNumber: 4200,
    blockHash: '0x' + 'cd'.repeat(32),
    logIndex: 3,
    incidentRef: '0x' + 'ef'.repeat(32),
    approvers: ['0x1111111111111111111111111111111111111111'],
    approvalCount: 2,
    requiredApprovals: 2,
    executedAt: new Date('2026-09-13T00:00:00Z'),
    ...overrides,
  };
}

export function claim(pool: Pool, owner: string, runKey = 'daemon-1'): Promise<RunClaim> {
  return claimRun({ runKey, mode: 'DAEMON', owner, leaseTtlMs: TTL_MS }, pool);
}

/** Claim and unwrap, for the many scenarios where the claim must succeed. */
export async function claimOrThrow(
  pool: Pool,
  owner: string,
  runKey = 'daemon-1',
): Promise<ClaimedRun> {
  const result = await claim(pool, owner, runKey);
  if (!result.claimed) {
    throw new Error(`expected ${owner} to claim ${runKey}, refused with ${result.refusal}`);
  }
  return result.run;
}

export function openIncident(
  pool: Pool,
  runKey = 'daemon-1',
  codes = ['AMOUNT_MISMATCH'],
): Promise<{ row: TradeContainmentRow; opened: boolean }> {
  return openContainment(
    {
      tradeId: '7',
      incidentReference: `RECON-20260912-${runKey.replace(/[^0-9a-z]/giu, '').toUpperCase()}`,
      runKey,
      qualifyingCodes: codes,
      evidence: { runKey, boundaryBlock: 10 },
    },
    pool,
  );
}

/** Take the containment through to the one state a release can start from. */
export async function readyForRelease(pool: Pool): Promise<void> {
  await openIncident(pool, 'daemon-1');
  await recordPauseObservation(pausedAt('7'), pool);
  await recordCleanReconciliation({ tradeId: '7', runKey: 'daemon-2' }, pool);
}
