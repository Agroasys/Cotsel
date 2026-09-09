import { WebhookNotifier } from '@agroasys/notifications';
import { config } from '../config';
import { OnchainClient } from '../blockchain/client';
import { IndexerClient } from '../indexer/client';
import { Logger } from '../utils/logger';
import { classifyDrifts } from './classifier';
import {
  advanceCoverageCursor,
  completeRun,
  createRun,
  failRun,
  readCoverageCursor,
  recordCoverageTailSighting,
  upsertDrift,
  upsertRunTradeScope,
} from '../database/queries';
import {
  batchTradeIds,
  checkIndexerSurplus,
  compareCoverage,
  evaluateCoverageSla,
  planCoverageWindow,
  tradeIdsInWindow,
  type ChainTradeRecord,
} from './coverage';
import {
  DriftFinding,
  DriftSeverity,
  ReconcileMode,
  RunStats,
  type CoverageBoundary,
} from '../types';

const DEFAULT_SEVERITY_COUNTS: Record<DriftSeverity, number> = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generateRunKey(mode: ReconcileMode): string {
  if (mode === 'DAEMON') {
    const bucket = Math.floor(Date.now() / config.daemonIntervalMs);
    return `daemon-${bucket}`;
  }
  return `once-${new Date().toISOString()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded-concurrency map, so a wide window cannot stampede the RPC endpoint. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

function skippedStats(
  runKey: string,
  mode: ReconcileMode,
  row: {
    total_trades: number;
    drift_count: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
  },
  skippedReason: string,
): RunStats {
  return {
    runKey,
    mode,
    status: 'SKIPPED',
    totalTrades: row.total_trades,
    driftCount: row.drift_count,
    severityCounts: {
      CRITICAL: row.critical_count,
      HIGH: row.high_count,
      MEDIUM: row.medium_count,
      LOW: row.low_count,
    },
    skippedReason,
  };
}

export class ReconciliationService {
  private readonly onchainClient = new OnchainClient();
  private readonly indexerClient = new IndexerClient(config.indexerGraphqlUrl);
  private readonly notifier = new WebhookNotifier({
    enabled: config.notificationsEnabled,
    webhookUrl: config.notificationsWebhookUrl,
    cooldownMs: config.notificationsCooldownMs,
    requestTimeoutMs: config.notificationsRequestTimeoutMs,
    logger: Logger,
  });

  private async notifyCriticalDrift(runKey: string, finding: DriftFinding): Promise<void> {
    if (finding.severity !== 'CRITICAL') {
      return;
    }

    const isCoverageGap =
      finding.mismatchCode === 'INDEXER_TRADE_MISSING' ||
      finding.mismatchCode === 'INDEXER_SURPLUS_RECORDS';

    await this.notifier.notify({
      source: 'reconciliation',
      type: isCoverageGap ? 'RECONCILIATION_COVERAGE_GAP' : 'RECONCILIATION_CRITICAL_DRIFT',
      severity: 'critical',
      dedupKey:
        (isCoverageGap ? 'reconciliation:coverage:' : 'reconciliation:critical:') +
        finding.tradeId +
        ':' +
        finding.mismatchCode,
      message: isCoverageGap
        ? 'Chain-derived reconciliation coverage gap detected between the chain and the indexer projection.'
        : 'Critical reconciliation drift detected between on-chain and indexed trade state.',
      correlation: {
        tradeId: finding.tradeId,
        runKey,
        mismatchCode: finding.mismatchCode,
      },
      metadata: {
        onchainValue: finding.onchainValue,
        indexedValue: finding.indexedValue,
      },
    });
  }

  private async notifyCoverageBacklog(
    runKey: string,
    reason: string,
    uncoveredTail: bigint,
    boundary: CoverageBoundary,
  ): Promise<void> {
    await this.notifier.notify({
      source: 'reconciliation',
      type: 'RECONCILIATION_COVERAGE_BACKLOG',
      severity: 'critical',
      dedupKey: 'reconciliation:coverage-backlog',
      message:
        'Reconciliation cannot keep up with the chain trade range; the uncovered tail has breached its age SLA.',
      correlation: { runKey },
      metadata: {
        reason,
        uncoveredTail: uncoveredTail.toString(),
        chainTradeCounter: boundary.chainTradeCounter.toString(),
        boundaryBlock: boundary.blockNumber,
      },
    });
  }

  private async recordFinding(
    runId: number,
    runKey: string,
    finding: DriftFinding,
    stats: RunStats,
  ): Promise<void> {
    await upsertDrift(runId, runKey, finding);
    await this.notifyCriticalDrift(runKey, finding);

    stats.driftCount += 1;
    stats.severityCounts[finding.severity] += 1;

    Logger.warn('Reconciliation drift detected', {
      runKey,
      tradeId: finding.tradeId,
      mismatchCode: finding.mismatchCode,
      severity: finding.severity,
    });
  }

  async reconcileOnce(mode: ReconcileMode, runKeyOverride?: string): Promise<RunStats> {
    const runKey = runKeyOverride || generateRunKey(mode);
    const run = await createRun(runKey, mode);

    if (!run.created && run.row.status === 'COMPLETED') {
      Logger.warn('Skipping already completed reconciliation run key', { runKey, mode });
      return skippedStats(runKey, mode, run.row, 'run_key already completed');
    }

    if (!run.created && run.row.status === 'RUNNING') {
      Logger.warn('Skipping run key currently marked RUNNING', { runKey, mode });
      return skippedStats(runKey, mode, run.row, 'run_key currently running');
    }

    const stats: RunStats = {
      runKey,
      mode,
      status: 'COMPLETED',
      totalTrades: 0,
      driftCount: 0,
      severityCounts: { ...DEFAULT_SEVERITY_COUNTS },
    };

    try {
      // The chain is the independent enumeration authority. Every read below is
      // pinned to this one boundary block.
      const boundary = await this.onchainClient.resolveBoundary();
      const cursor = await readCoverageCursor();
      const window = planCoverageWindow({
        cursor: cursor.lastTradeId,
        chainTradeCounter: boundary.chainTradeCounter,
        budget: config.maxTradesPerRun,
      });

      Logger.info('Reconciliation coverage window planned', {
        runKey,
        fromTradeId: window.fromTradeId.toString(),
        toTradeId: window.toTradeId.toString(),
        chainTradeCounter: boundary.chainTradeCounter.toString(),
        boundaryBlock: boundary.blockNumber,
        boundaryTag: boundary.tag,
        uncoveredTail: window.uncoveredTail.toString(),
      });

      const windowIds = tradeIdsInWindow(window);
      let coverageGaps = 0;

      for (const idBatch of batchTradeIds(windowIds, config.batchSize)) {
        const chainTrades = await mapWithConcurrency<string, ChainTradeRecord>(
          idBatch,
          config.chainReadConcurrency,
          async (tradeId) => {
            try {
              return {
                tradeId,
                trade: await this.onchainClient.getTrade(tradeId, boundary.blockNumber),
              };
            } catch (error: unknown) {
              return { tradeId, trade: null, readError: getErrorMessage(error) };
            }
          },
        );

        const indexedTrades = await this.indexerClient.fetchTradesByIds(idBatch);
        const comparison = compareCoverage({
          window,
          boundary,
          chainTrades,
          indexedTrades,
        });

        for (const finding of comparison.missingFromIndexer) {
          stats.totalTrades += 1;
          await upsertRunTradeScope(run.row.id, runKey, finding.tradeId);
          await this.recordFinding(run.row.id, runKey, finding, stats);
          if (finding.mismatchCode === 'INDEXER_TRADE_MISSING') {
            coverageGaps += 1;
          }
        }

        for (const pair of comparison.paired) {
          stats.totalTrades += 1;
          await upsertRunTradeScope(run.row.id, runKey, pair.indexed.tradeId);

          for (const finding of classifyDrifts({
            indexedTrade: pair.indexed,
            onchainTrade: pair.onchain,
            onchainReadError: pair.readError,
          })) {
            await this.recordFinding(run.row.id, runKey, finding, stats);
          }
        }

        for (const indexerOnly of comparison.indexerOnly) {
          stats.totalTrades += 1;
          await upsertRunTradeScope(run.row.id, runKey, indexerOnly.tradeId);
          await this.recordFinding(
            run.row.id,
            runKey,
            {
              tradeId: indexerOnly.tradeId,
              severity: 'CRITICAL',
              mismatchCode: 'ONCHAIN_TRADE_MISSING',
              comparedField: 'tradePresence',
              onchainValue: null,
              indexedValue: indexerOnly.tradeId,
              details: {
                reason: 'indexer returned a trade outside the chain-derived id window',
                boundaryBlock: boundary.blockNumber,
              },
            },
            stats,
          );
        }
      }

      let indexerTradeCount: number | null = null;
      try {
        indexerTradeCount = await this.indexerClient.fetchTradeCount();
      } catch (error: unknown) {
        Logger.warn('Could not read indexer trade count for the surplus check', {
          runKey,
          error: getErrorMessage(error),
        });
      }

      const surplus = checkIndexerSurplus({ indexerTradeCount, boundary });
      if (surplus) {
        await this.recordFinding(run.row.id, runKey, surplus, stats);
      }

      const now = new Date();
      const tailFirstSeenAt = window.uncoveredTail === 0n ? null : (cursor.tailFirstSeenAt ?? now);
      const sla = evaluateCoverageSla({
        uncoveredTail: window.uncoveredTail,
        tailFirstSeenAt: cursor.tailFirstSeenAt,
        now,
        maxAgeMs: config.coverageMaxAgeMs,
      });

      // A gap parks the cursor: advancing past an unreconciled range would
      // retire the evidence and let the next run report clean.
      const cursorAdvanced = coverageGaps === 0;
      if (cursorAdvanced) {
        await advanceCoverageCursor({
          lastTradeId: window.nextCursor,
          boundaryBlockNumber: boundary.blockNumber,
          boundaryBlockHash: boundary.blockHash,
          tailFirstSeenAt,
        });
      } else {
        await recordCoverageTailSighting({ tailFirstSeenAt });
        Logger.error('Holding the reconciliation cursor on an unresolved coverage gap', {
          runKey,
          coverageGaps,
          heldAtTradeId: cursor.lastTradeId.toString(),
        });
      }

      if (sla.breached && sla.reason) {
        await this.notifyCoverageBacklog(runKey, sla.reason, window.uncoveredTail, boundary);
      }

      stats.coverage = {
        boundary,
        window,
        fromBlock: cursor.boundaryBlockNumber,
        indexerTradeCount,
        sla,
        cursorAdvanced,
      };

      await completeRun(stats);

      Logger.info('Reconciliation run completed', {
        runKey,
        mode,
        totalTrades: stats.totalTrades,
        driftCount: stats.driftCount,
        critical: stats.severityCounts.CRITICAL,
        high: stats.severityCounts.HIGH,
        coveredFromTradeId: window.fromTradeId.toString(),
        coveredToTradeId: window.toTradeId.toString(),
        blockInterval: `${cursor.boundaryBlockNumber}..${boundary.blockNumber}`,
        nextCursor: window.nextCursor.toString(),
        uncoveredTail: window.uncoveredTail.toString(),
        coverageComplete: window.complete,
        cursorAdvanced,
        slaBreached: sla.breached,
      });

      return stats;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      await failRun(runKey, message);
      Logger.error('Reconciliation run failed', { runKey, mode, error: message });
      throw error;
    }
  }

  async runDaemon(): Promise<void> {
    if (!config.enabled) {
      Logger.warn('Reconciliation daemon disabled by config', {
        configKey: 'RECONCILIATION_ENABLED',
        currentValue: config.enabled,
      });
      return;
    }

    Logger.info('Reconciliation daemon started', {
      intervalMs: config.daemonIntervalMs,
      batchSize: config.batchSize,
      maxTradesPerRun: config.maxTradesPerRun,
      coverageBoundary: config.coverageBoundary,
      coverageMaxAgeMs: config.coverageMaxAgeMs,
    });

    while (true) {
      try {
        await this.reconcileOnce('DAEMON');
      } catch (error: unknown) {
        Logger.error('Daemon run failed', { error: getErrorMessage(error) });
      }

      await sleep(config.daemonIntervalMs);
    }
  }
}
