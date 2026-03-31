import { Pool } from 'pg';
import { config } from '../config';
import { ReconciliationGateStatus } from '../types';

export interface TradeReconciliationGate {
  tradeId: string;
  status: ReconciliationGateStatus;
  runKey: string | null;
  driftCount: number;
  blockedReasons: string[];
}

interface LatestCompletedRunRow {
  run_key: string;
}

interface ScopedTradeRow {
  trade_id: string;
}

interface DriftCountRow {
  trade_id: string;
  drift_count: string;
}

export class ReconciliationGateService {
  private readonly pool: Pool | null = config.reconciliationDb
    ? new Pool({
        host: config.reconciliationDb.host,
        port: config.reconciliationDb.port,
        database: config.reconciliationDb.name,
        user: config.reconciliationDb.user,
        password: config.reconciliationDb.password,
        max: 2,
      })
    : null;

  async assessTrades(tradeIds: string[]): Promise<Map<string, TradeReconciliationGate>> {
    const uniqueTradeIds = [...new Set(tradeIds.filter((tradeId) => tradeId.trim().length > 0))];
    const result = new Map<string, TradeReconciliationGate>();

    if (uniqueTradeIds.length === 0) {
      return result;
    }

    if (!this.pool) {
      for (const tradeId of uniqueTradeIds) {
        result.set(tradeId, {
          tradeId,
          status: 'UNKNOWN',
          runKey: null,
          driftCount: 0,
          blockedReasons: ['Reconciliation database is not configured'],
        });
      }
      return result;
    }

    const latestRun = await this.pool.query<LatestCompletedRunRow>(
      `SELECT run_key
       FROM reconcile_runs
       WHERE status = 'COMPLETED'
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    );

    const runKey = latestRun.rows[0]?.run_key ?? null;
    if (!runKey) {
      for (const tradeId of uniqueTradeIds) {
        result.set(tradeId, {
          tradeId,
          status: 'UNKNOWN',
          runKey: null,
          driftCount: 0,
          blockedReasons: ['No completed reconciliation run is available'],
        });
      }
      return result;
    }

    const [scopedTrades, driftCounts] = await Promise.all([
      this.pool.query<ScopedTradeRow>(
        `SELECT trade_id
         FROM reconcile_run_trades
         WHERE run_key = $1
           AND trade_id = ANY($2::text[])`,
        [runKey, uniqueTradeIds],
      ),
      this.pool.query<DriftCountRow>(
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

      if (!scopedTradeIds.has(tradeId)) {
        result.set(tradeId, {
          tradeId,
          status: 'UNKNOWN',
          runKey,
          driftCount,
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
          blockedReasons: [`Latest reconciliation run reported ${driftCount} drift finding(s)`],
        });
        continue;
      }

      result.set(tradeId, {
        tradeId,
        status: 'CLEAR',
        runKey,
        driftCount: 0,
        blockedReasons: [],
      });
    }

    return result;
  }
}
