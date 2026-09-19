/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-10: the scheduled single-owner ingestion loop.
 *
 * Ingestion had no schedule. `--ingest-once` existed and the internal route
 * existed, but nothing in the deployment called either, so chain evidence
 * advanced only when a person or an unwritten external job happened to ask for
 * it. That is the shape of the finding: not a worker that fails loudly, but an
 * absent worker that nothing notices.
 *
 * Single ownership is enforced with a non-blocking advisory lock rather than a
 * queue. A second replica that cannot take the lock should skip its tick and
 * say so, not wait and then run a redundant pass against a head that has moved;
 * overlapping runs would also interleave their watermark writes. The declined
 * tick is still recorded, because "the schedule is alive but not mine" and "the
 * schedule is dead" must not look the same in the evidence.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Pool } from 'pg';
import { config } from '../config';
import { pool } from '../database/connection';
import {
  markIngestionAttemptStarted,
  markIngestionRunCompleted,
  markIngestionRunUnsuccessful,
  recordIngestionRun,
  type IngestionRunOutcome,
  type IngestionRunTriggerSource,
} from '../database/queries/ingestion';
import { recordIngestionRunOutcome } from '../metrics/counters';
import { Logger } from '../utils/logger';
import {
  INGESTION_CURSORS,
  TreasuryIngestionService,
  type TreasuryIngestionResult,
} from './ingestion';

const INGESTION_LOCK_NAMESPACE = 91401;
const INGESTION_LOCK_KEY = 'treasury:ingestion';

export interface IngestionWorkerRun {
  runKey: string;
  outcome: IngestionRunOutcome;
  result: TreasuryIngestionResult | null;
  error: string | null;
}

type PoolLike = Pick<Pool, 'connect'>;

interface IngestionRunner {
  ingestOnce(): Promise<TreasuryIngestionResult>;
}

export function resolveWorkerIdentity(): string {
  return `${hostname()}:${process.pid}`;
}

export class TreasuryIngestionWorker {
  private readonly ingestion: IngestionRunner;
  private readonly pool: PoolLike;
  private readonly intervalMs: number;
  private readonly workerIdentity: string;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<IngestionWorkerRun> | null = null;
  private stopped = false;

  constructor(deps?: {
    ingestion?: IngestionRunner;
    pool?: PoolLike;
    intervalMs?: number;
    workerIdentity?: string;
  }) {
    this.ingestion = deps?.ingestion ?? new TreasuryIngestionService();
    this.pool = deps?.pool ?? pool;
    this.intervalMs = deps?.intervalMs ?? config.ingestionIntervalMs;
    this.workerIdentity = deps?.workerIdentity ?? resolveWorkerIdentity();
  }

  /**
   * Runs immediately and then on a fixed delay *after* each run settles. A
   * fixed-rate interval would stack ticks behind a slow run, and the advisory
   * lock would then turn every stacked tick into a declined one -- a worker
   * that looks busy while ingesting nothing.
   */
  start(): void {
    this.stopped = false;
    Logger.info('Treasury ingestion worker started', {
      workerIdentity: this.workerIdentity,
      intervalMs: this.intervalMs,
    });
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }

    Logger.info('Treasury ingestion worker stopped', { workerIdentity: this.workerIdentity });
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      await this.runOnce('WORKER');
    } catch (error: unknown) {
      // runOnce already records and logs; this only keeps the loop alive.
      Logger.error('Treasury ingestion tick failed', {
        error: error instanceof Error ? error.message : error,
      });
    }

    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    // The HTTP server owns the process lifetime. An ingestion timer that also
    // held it open would keep a shutting-down pod alive for a whole interval.
    this.timer.unref?.();
  }

  async runOnce(triggerSource: IngestionRunTriggerSource): Promise<IngestionWorkerRun> {
    const run = this.executeRun(triggerSource);
    this.inFlight = run;

    try {
      return await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    }
  }

  private async executeRun(triggerSource: IngestionRunTriggerSource): Promise<IngestionWorkerRun> {
    const runKey = randomUUID();
    const startedAt = new Date();
    const client = await this.pool.connect();
    let acquired = false;

    try {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS acquired',
        [INGESTION_LOCK_NAMESPACE, INGESTION_LOCK_KEY],
      );
      acquired = lock.rows[0]?.acquired === true;

      if (!acquired) {
        return await this.finish({
          runKey,
          startedAt,
          triggerSource,
          outcome: 'NOT_OWNER',
          result: null,
          error: null,
          blockedReason: 'Another treasury replica holds the ingestion lease',
        });
      }

      await markIngestionAttemptStarted(INGESTION_CURSORS);
      const result = await this.ingestion.ingestOnce();

      if (result.blockedReason) {
        await markIngestionRunUnsuccessful(INGESTION_CURSORS, result.blockedReason);
        return await this.finish({
          runKey,
          startedAt,
          triggerSource,
          outcome: 'BLOCKED',
          result,
          error: null,
          blockedReason: result.blockedReason,
        });
      }

      await markIngestionRunCompleted(INGESTION_CURSORS);
      return await this.finish({
        runKey,
        startedAt,
        triggerSource,
        outcome: 'COMPLETED',
        result,
        error: null,
        blockedReason: null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ingestion run failed';
      // A throw is recorded with the same weight as a refusal. Both leave the
      // freshness watermark where it was, which is what blocks export.
      await markIngestionRunUnsuccessful(INGESTION_CURSORS, message).catch(() => undefined);
      return await this.finish({
        runKey,
        startedAt,
        triggerSource,
        outcome: 'FAILED',
        result: null,
        error: message,
        blockedReason: message,
      });
    } finally {
      try {
        if (acquired) {
          await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
            INGESTION_LOCK_NAMESPACE,
            INGESTION_LOCK_KEY,
          ]);
        }
      } finally {
        client.release();
      }
    }
  }

  private async finish(input: {
    runKey: string;
    startedAt: Date;
    triggerSource: IngestionRunTriggerSource;
    outcome: IngestionRunOutcome;
    result: TreasuryIngestionResult | null;
    error: string | null;
    blockedReason: string | null;
  }): Promise<IngestionWorkerRun> {
    const durationMs = Math.max(0, Date.now() - input.startedAt.getTime());
    const completed = input.outcome === 'COMPLETED';

    try {
      await recordIngestionRun({
        runKey: input.runKey,
        workerIdentity: this.workerIdentity,
        triggerSource: input.triggerSource,
        outcome: input.outcome,
        fetched: input.result?.fetched ?? 0,
        inserted: input.result?.inserted ?? 0,
        stableBlockNumber: input.result?.stableBlockNumber ?? null,
        indexerProcessedBlockNumber: input.result?.indexerProcessedBlockNumber ?? null,
        // Only a completed run proved a window; the table's own constraint
        // refuses a coverage height on any other outcome.
        ingestedThroughBlockNumber: completed
          ? (input.result?.ingestedThroughBlockNumber ?? null)
          : null,
        nextTradeBlockNumber: input.result?.nextTradeBlockNumber ?? null,
        nextClaimBlockNumber: input.result?.nextClaimBlockNumber ?? null,
        blockedReason: completed ? null : input.blockedReason,
        durationMs,
        startedAt: input.startedAt,
      });
    } catch (error: unknown) {
      // Losing the evidence row must not also lose the run. The watermark
      // writes above already carry the outcome that gates export.
      Logger.error('Treasury ingestion run evidence could not be recorded', {
        runKey: input.runKey,
        outcome: input.outcome,
        error: error instanceof Error ? error.message : error,
      });
    }

    recordIngestionRunOutcome(input.outcome, {
      runKey: input.runKey,
      workerIdentity: this.workerIdentity,
      triggerSource: input.triggerSource,
      durationMs,
      fetched: input.result?.fetched ?? 0,
      inserted: input.result?.inserted ?? 0,
      ingestedThroughBlockNumber: input.result?.ingestedThroughBlockNumber ?? null,
      blockedReason: input.blockedReason,
    });

    return {
      runKey: input.runKey,
      outcome: input.outcome,
      result: input.result,
      error: input.error,
    };
  }
}
