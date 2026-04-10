import { WebhookNotifier } from '@agroasys/notifications';
import { config } from '../config';
import { OnchainClient } from '../blockchain/client';
import { IndexerClient } from '../indexer/client';
import { Logger } from '../utils/logger';
import { classifyDrifts } from './classifier';
import {
  completeRun,
  createRun,
  failRun,
  upsertDrift,
  upsertRunTradeScope,
} from '../database/queries';
import { DriftFinding, DriftSeverity, ReconcileMode, RunStats } from '../types';
import { incrementDriftClassification } from '../metrics/counters';

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

    await this.notifier.notify({
      source: 'reconciliation',
      type: 'RECONCILIATION_CRITICAL_DRIFT',
      severity: 'critical',
      dedupKey: 'reconciliation:critical:' + finding.tradeId + ':' + finding.mismatchCode,
      message: 'Critical reconciliation drift detected between on-chain and indexed trade state.',
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

  async reconcileOnce(mode: ReconcileMode, runKeyOverride?: string): Promise<RunStats> {
    const runKey = runKeyOverride || generateRunKey(mode);
    const run = await createRun(runKey, mode);

    if (!run.created && run.row.status === 'COMPLETED') {
      Logger.warn('Skipping already completed reconciliation run key', { runKey, mode });
      return {
        runKey,
        mode,
        status: 'SKIPPED',
        totalTrades: run.row.total_trades,
        driftCount: run.row.drift_count,
        severityCounts: {
          CRITICAL: run.row.critical_count,
          HIGH: run.row.high_count,
          MEDIUM: run.row.medium_count,
          LOW: run.row.low_count,
        },
        skippedReason: 'run_key already completed',
      };
    }

    if (!run.created && run.row.status === 'RUNNING') {
      Logger.warn('Skipping run key currently marked RUNNING', { runKey, mode });
      return {
        runKey,
        mode,
        status: 'SKIPPED',
        totalTrades: run.row.total_trades,
        driftCount: run.row.drift_count,
        severityCounts: {
          CRITICAL: run.row.critical_count,
          HIGH: run.row.high_count,
          MEDIUM: run.row.medium_count,
          LOW: run.row.low_count,
        },
        skippedReason: 'run_key currently running',
      };
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
      let offset = 0;
      while (stats.totalTrades < config.maxTradesPerRun) {
        const remaining = config.maxTradesPerRun - stats.totalTrades;
        const limit = Math.min(config.batchSize, remaining);
        const indexedTrades = await this.indexerClient.fetchTrades(limit, offset);

        if (indexedTrades.length === 0) {
          break;
        }

        for (const indexedTrade of indexedTrades) {
          stats.totalTrades += 1;
          await upsertRunTradeScope(run.row.id, runKey, indexedTrade.tradeId);

          let onchainTrade = null;
          let onchainReadError: string | undefined;

          try {
            onchainTrade = await this.onchainClient.getTrade(indexedTrade.tradeId);
          } catch (error: unknown) {
            onchainReadError = getErrorMessage(error);
          }

          const findings = classifyDrifts({
            indexedTrade,
            onchainTrade,
            onchainReadError,
          });

          for (const finding of findings) {
            await upsertDrift(run.row.id, runKey, finding);
            await this.notifyCriticalDrift(runKey, finding);

            stats.driftCount += 1;
            stats.severityCounts[finding.severity] += 1;
            incrementDriftClassification(finding.severity, finding.mismatchCode);

            Logger.warn('Reconciliation drift detected', {
              runKey,
              tradeId: finding.tradeId,
              mismatchCode: finding.mismatchCode,
              severity: finding.severity,
            });
          }
        }

        offset += indexedTrades.length;

        if (indexedTrades.length < limit) {
          break;
        }
      }

      await completeRun(stats);

      Logger.info('Reconciliation run completed', {
        runKey,
        mode,
        totalTrades: stats.totalTrades,
        driftCount: stats.driftCount,
        critical: stats.severityCounts.CRITICAL,
        high: stats.severityCounts.HIGH,
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
