import { WebhookNotifier } from '@agroasys/notifications';
import { config } from '../config';
import { Logger } from '../utils/logger';
import type { AbandonedRunRecord, TradeContainmentRow } from '../types';

/**
 * Alerting for the run-lease and scoped-containment controls.
 *
 * Kept apart from the coverage alerts because these reach a different owner:
 * an abandoned run is a platform-liveness page, and a contained trade is a
 * request for an admin scoped-pause decision.
 */
export class RunAlerts {
  private readonly notifier = new WebhookNotifier({
    enabled: config.notificationsEnabled,
    webhookUrl: config.notificationsWebhookUrl,
    cooldownMs: config.notificationsCooldownMs,
    requestTimeoutMs: config.notificationsRequestTimeoutMs,
    logger: Logger,
  });

  /**
   * A run's lease expired while it was RUNNING.
   *
   * Deduplicated per run key rather than globally: one crashed worker holding
   * several keys is several distinct pieces of stuck work, and collapsing them
   * would hide all but the first.
   */
  async runAbandoned(record: AbandonedRunRecord): Promise<void> {
    await this.notifier.notify({
      source: 'reconciliation',
      type: 'RECONCILIATION_RUN_ABANDONED',
      severity: 'critical',
      dedupKey: `reconciliation:run-abandoned:${record.runKey}`,
      message:
        'A reconciliation run stopped heartbeating and was marked abandoned; its window is unreconciled until a successor claims it.',
      correlation: { runKey: record.runKey },
      metadata: {
        mode: record.mode,
        abandonedOwner: record.owner,
        leaseEpoch: record.epoch,
        startedAt: record.startedAt.toISOString(),
        leaseExpiresAt: record.leaseExpiresAt?.toISOString() ?? null,
        lastHeartbeatAt: record.lastHeartbeatAt?.toISOString() ?? null,
        takeoverCount: record.takeoverCount,
      },
    });
  }

  /**
   * A qualified discrepancy contained a trade and needs a scoped pause.
   *
   * Reconciliation is read-only and holds no admin key, so this alert is the
   * containment request: the escrow's own `pauseTrade` control is an admin
   * action, and this names the one trade it should be applied to.
   */
  async tradeContained(input: {
    runKey: string;
    containment: TradeContainmentRow;
    qualifyingCodes: string[];
  }): Promise<void> {
    await this.notifier.notify({
      source: 'reconciliation',
      type: 'RECONCILIATION_TRADE_CONTAINED',
      severity: 'critical',
      dedupKey: `reconciliation:contained:${input.containment.incident_reference}`,
      message:
        'A qualified reconciliation discrepancy contained a trade; apply the scoped pause to this trade only and do not let it progress.',
      correlation: {
        tradeId: input.containment.trade_id,
        runKey: input.runKey,
      },
      metadata: {
        incidentReference: input.containment.incident_reference,
        qualifyingCodes: input.qualifyingCodes.join(','),
        state: input.containment.state,
        openedRunKey: input.containment.opened_run_key,
        openedAt: input.containment.opened_at.toISOString(),
        observationCount: input.containment.observation_count,
      },
    });
  }
}
