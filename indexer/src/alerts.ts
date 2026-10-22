import {
  createServiceNotifications,
  type NotificationDispatcher,
  type Notifier,
  type OutboxQueryExecutor,
} from '@agroasys/notifications';
import type { IndexerConfig } from './config';
import type { QuarantinedLogEntry } from './quarantine';

export interface IndexerAlerts {
  poisonLogDetected(entry: QuarantinedLogEntry): Promise<void>;
  unresolvedQuarantineOnStartup(count: number): Promise<void>;
}

/**
 * Critical routing for the poison-log control. The payload carries the log
 * coordinates an operator needs to find the quarantined row, and never the raw
 * `data` payload or RPC credentials.
 *
 * The notifier is the durable outbox: the pipeline halts straight after raising
 * a poison-log alert, so the alert is committed before delivery is tried and is
 * still owed after the process exits.
 */
export class WebhookIndexerAlerts implements IndexerAlerts {
  constructor(private readonly notifier: Notifier) {}

  async poisonLogDetected(entry: QuarantinedLogEntry): Promise<void> {
    await this.notifier.notify({
      source: 'indexer',
      type: 'INDEXER_POISON_LOG',
      severity: 'critical',
      dedupKey: `indexer:poison:${entry.txHash}:${entry.logIndex}`,
      message:
        'Indexer quarantined an unprojectable escrow log and held the checkpoint. Settlement projection is stale until the cause is corrected and the range is replayed.',
      correlation: {
        txHash: entry.txHash,
      },
      metadata: {
        reason: entry.reason,
        blockNumber: entry.blockNumber,
        logIndex: entry.logIndex,
        contractAddress: entry.contractAddress,
        eventName: entry.eventName,
        abiFingerprint: entry.abiFingerprint,
        errorMessage: entry.errorMessage,
      },
    });
  }

  async unresolvedQuarantineOnStartup(count: number): Promise<void> {
    await this.notifier.notify({
      source: 'indexer',
      type: 'INDEXER_POISON_LOG',
      severity: 'critical',
      dedupKey: 'indexer:poison:startup-blocked',
      message:
        'Indexer startup blocked: quarantined escrow logs are unresolved, so the checkpoint stays held.',
      correlation: {},
      metadata: {
        unresolvedCount: count,
      },
    });
  }
}

/**
 * The indexer's alerts and the dispatcher that drains its outbox. The outbox
 * commits on the quarantine pool for the same reason the quarantine row does:
 * the alert must survive the processor transaction rolling back.
 */
export function createIndexerAlerts(
  config: IndexerConfig,
  executor: OutboxQueryExecutor,
): { alerts: IndexerAlerts; dispatcher: NotificationDispatcher } {
  const { notifier, dispatcher } = createServiceNotifications({
    enabled: config.notificationsEnabled,
    webhookUrl: config.notificationsWebhookUrl,
    escalationWebhookUrl: config.notificationsEscalationWebhookUrl,
    cooldownMs: config.notificationsCooldownMs,
    requestTimeoutMs: config.notificationsRequestTimeoutMs,
    executor,
  });
  return { alerts: new WebhookIndexerAlerts(notifier), dispatcher };
}
