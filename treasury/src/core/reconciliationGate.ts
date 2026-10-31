import { Pool } from 'pg';
import { resolvePostgresSslConfig } from '@agroasys/shared-db';
import { config } from '../config';
import { ReconciliationGateStatus } from '../types';

export interface TradeReconciliationGate {
  tradeId: string;
  status: ReconciliationGateStatus;
  runKey: string | null;
  driftCount: number;
  freshness: 'FRESH' | 'STALE' | 'MISSING';
  completedAt: Date | null;
  staleRunningRunCount: number;
  /**
   * WP-4 H-25. The chain watermark the accepted run actually reached. A run is
   * evidence about the range it covered and nothing else, so a caller has to be
   * able to ask whether its own block is inside that range -- a fresh, drift-free
   * run that stopped short of an entry says nothing about that entry.
   */
  coverageFromBlock: number | null;
  coverageToBlock: number | null;
  /** False or null means the run published a truncated or unproven range. */
  coverageComplete: boolean | null;
  blockedReasons: string[];
}

export interface ReconciliationRunAnchor {
  runKey: string;
  completedAt: Date;
  coverageFromBlock: number | null;
  coverageToBlock: number;
  coverageComplete: true;
  staleRunningRunCount: number;
}

export interface ReconciliationControlSummary {
  status: 'CLEAR' | 'BLOCKED' | 'STALE' | 'MISSING' | 'UNKNOWN';
  freshness: 'FRESH' | 'STALE' | 'MISSING';
  latestCompletedRunKey: string | null;
  latestCompletedRunAt: Date | null;
  latestCompletedRunAgeSeconds: number | null;
  /** WP-4 H-25: the exact chain watermark the accepted run reached. */
  coverageToBlock: number | null;
  coverageComplete: boolean | null;
  staleRunningRunCount: number;
  trackedTradeCount: number;
  clearTradeCount: number;
  blockedTradeCount: number;
  unknownTradeCount: number;
  driftBlockedTradeCount: number;
  blockedReasons: string[];
}

interface LatestCompletedRunRow {
  run_key: string;
  completed_at: Date | null;
  coverage_from_block: string | number | null;
  coverage_to_block: string | number | null;
  coverage_complete: boolean | null;
}

interface ScopedTradeRow {
  trade_id: string;
}

interface DriftCountRow {
  trade_id: string;
  drift_count: string;
}

interface CountRow {
  count: string;
}

type QueryReader = Pick<Pool, 'query'>;
type PoolLike = QueryReader & Partial<Pick<Pool, 'connect'>>;

/** `BIGINT` arrives as a string from `pg`, and `Number(null)` is `0`. */
function toBlockNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class ReconciliationGateService {
  private readonly pool: PoolLike | null;
  private readonly ownsPool: boolean;
  private readonly now: () => Date;
  private readonly maxAgeSeconds: number;
  private readonly maxRunningRunAgeSeconds: number;

  constructor(deps?: {
    pool?: PoolLike | null;
    now?: () => Date;
    maxAgeSeconds?: number;
    maxRunningRunAgeSeconds?: number;
  }) {
    this.ownsPool = deps?.pool === undefined && config.reconciliationDb !== null;
    this.pool =
      deps?.pool !== undefined
        ? deps.pool
        : config.reconciliationDb
          ? new Pool({
              host: config.reconciliationDb.host,
              port: config.reconciliationDb.port,
              database: config.reconciliationDb.name,
              user: config.reconciliationDb.user,
              password: config.reconciliationDb.password,
              ssl: resolvePostgresSslConfig(config.reconciliationDb.sslMode),
              options: '-c app.service_name=reconciliation',
              max: 2,
            })
          : null;
    this.now = deps?.now ?? (() => new Date());
    this.maxAgeSeconds = deps?.maxAgeSeconds ?? config.reconciliationMaxAgeSeconds;
    this.maxRunningRunAgeSeconds =
      deps?.maxRunningRunAgeSeconds ?? config.reconciliationMaxRunningRunAgeSeconds;
  }

  /** Whether a reconciliation reader is configured, making it part of the readiness profile. */
  isConfigured(): boolean {
    return this.pool !== null;
  }

  async close(): Promise<void> {
    if (this.ownsPool && this.pool instanceof Pool) await this.pool.end();
  }

  /** Readiness: the reconciliation reader can be queried, so realization is not blind. */
  async checkReadiness(): Promise<void> {
    if (!this.pool) {
      throw new Error('Reconciliation database is not configured');
    }
    await this.pool.query('SELECT 1');
  }

  private async consistentRead<T>(read: (reader: QueryReader) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Reconciliation database is not configured');
    if (!this.pool.connect) return read(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await read(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Evidence for an empty export, which has no trade on which to hang a gate. */
  async snapshotRunAnchor(): Promise<ReconciliationRunAnchor> {
    if (!this.pool) throw new Error('Reconciliation evidence is unavailable or incomplete');
    return this.consistentRead((reader) => this.readSnapshotRunAnchor(reader));
  }

  private async readSnapshotRunAnchor(reader: QueryReader): Promise<ReconciliationRunAnchor> {
    const latest = await reader.query<LatestCompletedRunRow>(
      `SELECT run_key, completed_at AT TIME ZONE 'UTC' AS completed_at, coverage_from_block, coverage_to_block, coverage_complete
       FROM reconcile_runs WHERE status='COMPLETED' ORDER BY completed_at DESC, id DESC LIMIT 1`,
    );
    const staleCutoff = new Date(this.now().getTime() - this.maxRunningRunAgeSeconds * 1000);
    const running = await reader.query<CountRow>(
      "SELECT COUNT(*)::text AS count FROM reconcile_runs WHERE status='RUNNING' AND started_at AT TIME ZONE 'UTC' < $1::timestamptz",
      [staleCutoff],
    );
    const row = latest.rows[0];
    const coverageToBlock = toBlockNumber(row?.coverage_to_block);
    const staleRunningRunCount = Number.parseInt(running.rows[0]?.count ?? '0', 10);
    const age = row?.completed_at ? this.now().getTime() - row.completed_at.getTime() : NaN;
    if (
      !row?.run_key ||
      !row.completed_at ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > this.maxAgeSeconds * 1000 ||
      coverageToBlock === null ||
      row.coverage_complete !== true ||
      staleRunningRunCount > 0
    ) {
      throw new Error('Reconciliation evidence is unavailable or incomplete');
    }
    return {
      runKey: row.run_key,
      completedAt: row.completed_at,
      coverageFromBlock: toBlockNumber(row.coverage_from_block),
      coverageToBlock,
      coverageComplete: true,
      staleRunningRunCount,
    };
  }

  async assessTrades(tradeIds: string[]): Promise<Map<string, TradeReconciliationGate>> {
    if (!this.pool) return this.assessTradesFromReader(tradeIds, null);
    return this.consistentRead((reader) => this.assessTradesFromReader(tradeIds, reader));
  }

  private async assessTradesFromReader(
    tradeIds: string[],
    reader: QueryReader | null,
  ): Promise<Map<string, TradeReconciliationGate>> {
    const uniqueTradeIds = [...new Set(tradeIds.filter((tradeId) => tradeId.trim().length > 0))];
    const result = new Map<string, TradeReconciliationGate>();

    if (uniqueTradeIds.length === 0) {
      return result;
    }

    if (!reader) {
      for (const tradeId of uniqueTradeIds) {
        result.set(tradeId, {
          tradeId,
          status: 'UNKNOWN',
          runKey: null,
          driftCount: 0,
          freshness: 'MISSING',
          completedAt: null,
          staleRunningRunCount: 0,
          coverageFromBlock: null,
          coverageToBlock: null,
          coverageComplete: null,
          blockedReasons: ['Reconciliation database is not configured'],
        });
      }
      return result;
    }

    const latestRun = await reader.query<LatestCompletedRunRow>(
      `SELECT run_key
              , completed_at AT TIME ZONE 'UTC' AS completed_at
              , coverage_from_block
              , coverage_to_block
              , coverage_complete
       FROM reconcile_runs
       WHERE status = 'COMPLETED'
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    );
    const staleRunningCutoff = new Date(this.now().getTime() - this.maxRunningRunAgeSeconds * 1000);
    const staleRunningRuns = await reader.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM reconcile_runs
       WHERE status = 'RUNNING'
         AND started_at AT TIME ZONE 'UTC' < $1::timestamptz`,
      [staleRunningCutoff],
    );
    const staleRunningRunCount = Number.parseInt(staleRunningRuns.rows[0]?.count ?? '0', 10);

    const runKey = latestRun.rows[0]?.run_key ?? null;
    const completedAt = latestRun.rows[0]?.completed_at ?? null;
    if (!runKey) {
      for (const tradeId of uniqueTradeIds) {
        result.set(tradeId, {
          tradeId,
          status: 'BLOCKED',
          runKey: null,
          driftCount: 0,
          freshness: 'MISSING',
          completedAt: null,
          staleRunningRunCount,
          coverageFromBlock: null,
          coverageToBlock: null,
          coverageComplete: null,
          blockedReasons: ['No completed reconciliation run is available'],
        });
      }
      return result;
    }

    const ageMs = completedAt === null ? NaN : this.now().getTime() - completedAt.getTime();
    const isStale = !Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.maxAgeSeconds * 1000;
    const freshnessReason = isStale
      ? completedAt === null
        ? 'Latest completed reconciliation run does not have a completion timestamp'
        : ageMs < 0
          ? 'Latest completed reconciliation run has a future completion timestamp'
          : `Latest completed reconciliation run is older than ${this.maxAgeSeconds} seconds`
      : null;
    const runningReason =
      staleRunningRunCount > 0
        ? `${staleRunningRunCount} reconciliation run(s) have remained RUNNING beyond ${this.maxRunningRunAgeSeconds} seconds`
        : null;

    // WP-4 H-25. A run that stopped short published a range, not a verdict.
    // Accepting it would let a truncated sweep clear every trade it happened to
    // reach and say nothing about the ones it did not -- which is
    // indistinguishable, downstream, from a clean run.
    const coverageFromBlock = toBlockNumber(latestRun.rows[0]?.coverage_from_block);
    const coverageToBlock = toBlockNumber(latestRun.rows[0]?.coverage_to_block);
    const coverageComplete = latestRun.rows[0]?.coverage_complete ?? null;
    const coverageReason =
      coverageComplete === true && coverageToBlock !== null
        ? null
        : coverageComplete === false
          ? 'Latest completed reconciliation run published an incomplete chain range'
          : 'Latest completed reconciliation run did not publish a chain coverage watermark';

    const [scopedTrades, driftCounts] = await Promise.all([
      reader.query<ScopedTradeRow>(
        `SELECT trade_id
         FROM reconcile_run_trades
         WHERE run_key = $1
           AND trade_id = ANY($2::text[])`,
        [runKey, uniqueTradeIds],
      ),
      reader.query<DriftCountRow>(
        `SELECT trade_id, COUNT(*)::text AS drift_count
         FROM reconcile_drifts
         WHERE run_key = $1
           AND trade_id = ANY($2::text[])
         GROUP BY trade_id`,
        [runKey, uniqueTradeIds],
      ),
    ]);

    const scopedTradeIds = new Set(scopedTrades.rows.map((row) => row.trade_id));
    const driftCountByTradeId = new Map(
      driftCounts.rows.map((row) => [row.trade_id, Number.parseInt(row.drift_count, 10)]),
    );

    for (const tradeId of uniqueTradeIds) {
      const driftCount = driftCountByTradeId.get(tradeId) ?? 0;
      const blockedReasons: string[] = [];

      if (freshnessReason) {
        blockedReasons.push(freshnessReason);
      }
      if (runningReason) {
        blockedReasons.push(runningReason);
      }
      if (coverageReason) {
        blockedReasons.push(coverageReason);
      }

      if (blockedReasons.length > 0) {
        result.set(tradeId, {
          tradeId,
          status: 'BLOCKED',
          runKey,
          driftCount,
          // Coverage is not freshness. A run can be current and still have
          // published no watermark, and reporting that as STALE would send an
          // operator to look at the schedule instead of at the run.
          freshness: isStale ? 'STALE' : 'FRESH',
          completedAt,
          staleRunningRunCount,
          coverageFromBlock,
          coverageToBlock,
          coverageComplete,
          blockedReasons,
        });
        continue;
      }

      if (!scopedTradeIds.has(tradeId)) {
        result.set(tradeId, {
          tradeId,
          status: 'UNKNOWN',
          runKey,
          driftCount,
          freshness: 'FRESH',
          completedAt,
          staleRunningRunCount,
          coverageFromBlock,
          coverageToBlock,
          coverageComplete,
          blockedReasons: ['Trade is not covered by the latest completed reconciliation run'],
        });
        continue;
      }

      if (driftCount > 0) {
        result.set(tradeId, {
          tradeId,
          status: 'BLOCKED',
          runKey,
          driftCount,
          freshness: 'FRESH',
          completedAt,
          staleRunningRunCount,
          coverageFromBlock,
          coverageToBlock,
          coverageComplete,
          blockedReasons: [`Latest reconciliation run reported ${driftCount} drift finding(s)`],
        });
        continue;
      }

      result.set(tradeId, {
        tradeId,
        status: 'CLEAR',
        runKey,
        driftCount: 0,
        freshness: 'FRESH',
        completedAt,
        staleRunningRunCount,
        coverageFromBlock,
        coverageToBlock,
        coverageComplete,
        blockedReasons: [],
      });
    }

    return result;
  }

  async summarizeTrades(tradeIds: string[]): Promise<ReconciliationControlSummary> {
    const gates = await this.assessTrades(tradeIds);
    const values = [...gates.values()];
    const freshness = values[0]?.freshness ?? 'MISSING';
    const latestCompletedRunKey = values[0]?.runKey ?? null;
    const latestCompletedRunAt = values[0]?.completedAt ?? null;
    const staleRunningRunCount = values[0]?.staleRunningRunCount ?? 0;
    const coverageToBlock = values[0]?.coverageToBlock ?? null;
    const coverageComplete = values[0]?.coverageComplete ?? null;
    const latestCompletedRunAgeSeconds =
      latestCompletedRunAt === null || latestCompletedRunAt === undefined
        ? null
        : Math.max(0, Math.floor((this.now().getTime() - latestCompletedRunAt.getTime()) / 1000));
    const clearTradeCount = values.filter((gate) => gate.status === 'CLEAR').length;
    const blockedTradeCount = values.filter((gate) => gate.status === 'BLOCKED').length;
    const unknownTradeCount = values.filter((gate) => gate.status === 'UNKNOWN').length;
    const driftBlockedTradeCount = values.filter((gate) => gate.driftCount > 0).length;
    const blockedReasons = Array.from(
      new Set(values.flatMap((gate) => gate.blockedReasons).filter((reason) => reason.length > 0)),
    );

    let status: ReconciliationControlSummary['status'] = 'CLEAR';
    if (freshness === 'MISSING') {
      status = 'MISSING';
    } else if (freshness === 'STALE') {
      status = 'STALE';
    } else if (unknownTradeCount > 0) {
      status = 'UNKNOWN';
    } else if (blockedTradeCount > 0) {
      status = 'BLOCKED';
    }

    return {
      status,
      freshness,
      latestCompletedRunKey,
      latestCompletedRunAt,
      latestCompletedRunAgeSeconds,
      coverageToBlock,
      coverageComplete,
      staleRunningRunCount,
      trackedTradeCount: values.length,
      clearTradeCount,
      blockedTradeCount,
      unknownTradeCount,
      driftBlockedTradeCount,
      blockedReasons,
    };
  }
}
