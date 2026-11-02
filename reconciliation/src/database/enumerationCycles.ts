import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './connection';
import type { CoverageBoundary, DriftFinding, RunStats } from '../types';
import { holdsCursor } from '../core/coverage';

export interface EnumerationCycle {
  id: string;
  source_identity: string;
  anchor_block: string;
  anchor_hash: string;
  chain_counter: string;
  chain_cursor: string;
  expected_count: string;
  upper_id: string | null;
  after_id: string | null;
  walked: string;
  generation: string;
  exhausted: boolean;
  coherent: boolean;
  finished: boolean;
}
export interface IdentityPage {
  records: Array<{ id: string; tradeId: string }>;
  nextId: string | null;
  exhausted: boolean;
}
export function indexerSourceIdentity(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}
export function sameCycleSource(
  cycle: EnumerationCycle,
  boundary: CoverageBoundary,
  source: string,
): boolean {
  return (
    cycle.coherent &&
    cycle.source_identity === source &&
    Number(cycle.anchor_block) === boundary.blockNumber &&
    cycle.anchor_hash === boundary.blockHash.toLowerCase() &&
    BigInt(cycle.chain_counter) === boundary.chainTradeCounter
  );
}
export async function readActiveEnumerationCycle(): Promise<EnumerationCycle | null> {
  const result = await pool.query<EnumerationCycle>(
    "SELECT * FROM reconcile_enumeration_cycles WHERE scope='trades' AND NOT finished",
  );
  return result.rows[0] ?? null;
}
export async function createEnumerationCycle(input: {
  boundary: CoverageBoundary;
  source: string;
  upperId: string | null;
  chainCursor: bigint;
  expectedCount: number;
  coherent: boolean;
}): Promise<EnumerationCycle> {
  const result = await pool.query<EnumerationCycle>(
    `INSERT INTO reconcile_enumeration_cycles
    (id,scope,source_identity,anchor_block,anchor_hash,chain_counter,upper_id,coherent,expected_count,start_cursor,chain_cursor)
    VALUES ($1,'trades',$2,$3,$4,$5::numeric,$6,$7,$8,$9::numeric,$9::numeric)
    ON CONFLICT (scope) WHERE NOT finished DO NOTHING RETURNING *`,
    [
      randomUUID(),
      input.source,
      input.boundary.blockNumber,
      input.boundary.blockHash.toLowerCase(),
      input.boundary.chainTradeCounter.toString(),
      input.upperId,
      input.coherent,
      input.expectedCount,
      input.chainCursor.toString(),
    ],
  );
  const cycle = result.rows[0] ?? (await readActiveEnumerationCycle());
  if (!cycle) throw new Error('Enumeration cycle unavailable');
  return cycle;
}
export async function hasEnumerationHistory(): Promise<boolean> {
  return (await pool.query('SELECT 1 FROM reconcile_enumeration_cycles LIMIT 1')).rowCount !== 0;
}

/** Counts only candidate logical IDs, keeping memory and SQL parameter size bounded. */
export async function previousIdentityCounts(
  cycleId: string,
  ids: string[],
): Promise<Map<string, number>> {
  const result = await pool.query<{ trade_id: string; count: string }>(
    `SELECT trade_id,count(*)::text AS count
    FROM reconcile_enumeration_members WHERE cycle_id=$1 AND trade_id=ANY($2::text[]) GROUP BY trade_id`,
    [cycleId, ids],
  );
  return new Map(
    result.rows.map((row: { trade_id: string; count: string }) => [
      row.trade_id,
      Number(row.count),
    ]),
  );
}
export async function priorCycleHasHoldingFindings(cycleId: string): Promise<boolean> {
  const result = await pool.query<{ mismatch_code: DriftFinding['mismatchCode'] }>(
    `SELECT DISTINCT d.mismatch_code FROM reconcile_drifts d
    JOIN reconcile_runs r ON r.run_key=d.run_key WHERE r.coverage_cycle_id=$1 AND r.status='COMPLETED'`,
    [cycleId],
  );
  return result.rows.some((row: { mismatch_code: DriftFinding['mismatchCode'] }) =>
    holdsCursor(row.mismatch_code),
  );
}

/** Called only inside finalizeRun's lease-fenced transaction. A losing page commits nothing. */
export async function publishEnumerationPage(
  input: {
    cycle: EnumerationCycle;
    page: IdentityPage;
    coherent: boolean;
    finished: boolean;
    nextChainCursor: bigint;
    runId: number;
  },
  client: PoolClient,
): Promise<void> {
  const updated = await client.query(
    `UPDATE reconcile_enumeration_cycles SET after_id=$3,exhausted=$4,
    walked=walked+$5,coherent=coherent AND $6,chain_cursor=$7::numeric,generation=generation+1,updated_at=clock_timestamp()
    WHERE id=$1 AND generation=$2::bigint AND NOT finished RETURNING id`,
    [
      input.cycle.id,
      input.cycle.generation,
      input.page.nextId,
      input.page.exhausted,
      input.page.records.length,
      input.coherent,
      input.nextChainCursor.toString(),
    ],
  );
  if (updated.rowCount !== 1) throw new Error('Enumeration cycle advanced by another worker');
  await client.query('UPDATE reconcile_runs SET coverage_cycle_id=$2 WHERE id=$1', [
    input.runId,
    input.cycle.id,
  ]);
  await client.query(
    `INSERT INTO reconcile_enumeration_members(cycle_id,physical_id,trade_id)
    SELECT $1, value.id, value."tradeId" FROM jsonb_to_recordset($2::jsonb) AS value(id text,"tradeId" text)`,
    [input.cycle.id, JSON.stringify(input.page.records)],
  );
  if (input.finished)
    await client.query(
      'UPDATE reconcile_enumeration_cycles SET finished=true,generation=generation+1 WHERE id=$1',
      [input.cycle.id],
    );
}

/** Terminal evidence includes the complete cycle, rather than only its final window. */
export async function aggregateCycleEvidence(
  input: {
    cycleId: string;
    runId: number;
    runKey: string;
    stats: RunStats;
  },
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO reconcile_run_trades(run_id,run_key,trade_id)
    SELECT $2,$3,s.trade_id FROM reconcile_run_trades s JOIN reconcile_runs r ON r.run_key=s.run_key
    WHERE r.coverage_cycle_id=$1 AND r.status='COMPLETED' GROUP BY s.trade_id
    ON CONFLICT (run_key,trade_id) DO NOTHING`,
    [input.cycleId, input.runId, input.runKey],
  );
  await client.query(
    `INSERT INTO reconcile_drifts(run_id,run_key,trade_id,severity,mismatch_code,compared_field,onchain_value,indexed_value,details)
    SELECT $2,$3,d.trade_id,d.severity,d.mismatch_code,d.compared_field,d.onchain_value,d.indexed_value,d.details
    FROM (SELECT DISTINCT ON (d.trade_id,d.mismatch_code,d.compared_field) d.* FROM reconcile_drifts d
      JOIN reconcile_runs r ON r.run_key=d.run_key WHERE r.coverage_cycle_id=$1 AND r.status='COMPLETED'
      ORDER BY d.trade_id,d.mismatch_code,d.compared_field,r.id DESC) d
    ON CONFLICT (run_key,trade_id,mismatch_code,compared_field) DO NOTHING`,
    [input.cycleId, input.runId, input.runKey],
  );
  const scope = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reconcile_run_trades WHERE run_key=$1',
    [input.runKey],
  );
  const counts = await client.query<{ severity: keyof RunStats['severityCounts']; count: string }>(
    'SELECT severity,count(*)::text AS count FROM reconcile_drifts WHERE run_key=$1 GROUP BY severity',
    [input.runKey],
  );
  input.stats.totalTrades = Number(scope.rows[0].count);
  input.stats.driftCount = 0;
  for (const key of Object.keys(input.stats.severityCounts) as Array<
    keyof RunStats['severityCounts']
  >)
    input.stats.severityCounts[key] = 0;
  for (const row of counts.rows) {
    input.stats.severityCounts[row.severity] = Number(row.count);
    input.stats.driftCount += Number(row.count);
  }
}
