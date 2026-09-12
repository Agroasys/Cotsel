import { WebhookNotifier } from '@agroasys/notifications';
import { config } from '../config';
import { Logger } from '../utils/logger';
import type { CoverageBoundary, DriftFinding } from '../types';

/**
 * Severity-routed alerting for the coverage controls.
 *
 * Kept apart from the run loop so the reconciler reads as the comparison it is,
 * and so alert wording and dedup keys live in one place.
 */
export class CoverageAlerts {
  private readonly notifier = new WebhookNotifier({
    enabled: config.notificationsEnabled,
    webhookUrl: config.notificationsWebhookUrl,
    cooldownMs: config.notificationsCooldownMs,
    requestTimeoutMs: config.notificationsRequestTimeoutMs,
    logger: Logger,
  });

  async criticalDrift(runKey: string, finding: DriftFinding): Promise<void> {
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

  async coverageBacklog(
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
}
