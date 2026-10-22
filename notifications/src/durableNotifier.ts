import { WebhookNotifier } from './index';
import type { NotificationEvent, NotificationLogger, Notifier } from './index';
import {
  DEFAULT_OUTBOX_LEASE_MS,
  NotificationDispatcher,
  type NotificationDispatcherConfig,
} from './dispatcher';
import { NotificationOutbox, type EnqueueResult, type OutboxQueryExecutor } from './outbox';

export type DurableEnqueueResult = EnqueueResult | 'disabled';

export interface DurableNotifierConfig {
  enabled: boolean;
  cooldownMs: number;
  outbox: NotificationOutbox;
  /** Kicked after each `notify` so a new alert does not wait for the next timer tick. */
  dispatcher?: NotificationDispatcher;
  /**
   * Used only when the outbox itself cannot be written, so a database outage
   * degrades to the old best-effort delivery instead of dropping the alert.
   */
  fallback?: Notifier;
  logger?: NotificationLogger;
}

/**
 * The producer-facing side of the outbox: same `notify` contract as
 * `WebhookNotifier`, but the alert is durable before `notify` returns.
 */
export class DurableNotifier implements Notifier {
  constructor(private readonly config: DurableNotifierConfig) {}

  /**
   * Record an alert, optionally inside the caller's transaction. Throws when
   * the outbox cannot be written, so a caller with its own durable queue can
   * leave its row pending.
   */
  async enqueue(
    event: NotificationEvent,
    executor?: OutboxQueryExecutor,
  ): Promise<DurableEnqueueResult> {
    if (!this.config.enabled) {
      return 'disabled';
    }
    return this.config.outbox.enqueue(event, this.config.cooldownMs, executor);
  }

  /** Never throws: an alert that cannot be recorded falls back to direct delivery. */
  async notify(event: NotificationEvent): Promise<boolean> {
    let result: DurableEnqueueResult;
    try {
      result = await this.enqueue(event);
    } catch (error: unknown) {
      this.config.logger?.error('Could not record notification in the outbox', {
        source: event.source,
        type: event.type,
        severity: event.severity,
        dedupKey: event.dedupKey,
        error: error instanceof Error ? error.message : String(error),
        fallback: Boolean(this.config.fallback),
      });
      return this.config.fallback ? this.config.fallback.notify(event) : false;
    }

    if (result === 'disabled') {
      return false;
    }
    if (result === 'suppressed') {
      this.config.logger?.info('Notification suppressed by durable cooldown dedup', {
        dedupKey: event.dedupKey,
        cooldownMs: this.config.cooldownMs,
      });
      return false;
    }

    await this.kick();
    return true;
  }

  /** Attempt delivery now; a failure here leaves the row for the next pass. */
  async kick(): Promise<void> {
    if (!this.config.dispatcher) {
      return;
    }
    try {
      await this.config.dispatcher.runOnce();
    } catch (error: unknown) {
      this.config.logger?.error('Notification outbox pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface ServiceNotificationsConfig {
  enabled: boolean;
  webhookUrl?: string | null;
  escalationWebhookUrl?: string | null;
  cooldownMs: number;
  requestTimeoutMs: number;
  executor: OutboxQueryExecutor;
  logger?: NotificationLogger;
  dispatcher?: Partial<
    Omit<
      NotificationDispatcherConfig,
      'outbox' | 'transport' | 'escalationTransport' | 'logger' | 'enabled'
    >
  >;
}

export interface ServiceNotifications {
  notifier: DurableNotifier;
  dispatcher: NotificationDispatcher;
  outbox: NotificationOutbox;
}

/** One service's outbox, primary and escalation routes, and dispatcher. */
export function createServiceNotifications(
  config: ServiceNotificationsConfig,
): ServiceNotifications {
  const primary = new WebhookNotifier({
    enabled: config.enabled,
    webhookUrl: config.webhookUrl ?? undefined,
    cooldownMs: config.cooldownMs,
    requestTimeoutMs: config.requestTimeoutMs,
    logger: config.logger,
  });
  const escalation = config.escalationWebhookUrl
    ? new WebhookNotifier({
        enabled: config.enabled,
        webhookUrl: config.escalationWebhookUrl,
        cooldownMs: 0,
        requestTimeoutMs: config.requestTimeoutMs,
        logger: config.logger,
      })
    : undefined;

  const outbox = new NotificationOutbox(config.executor);
  const dispatcher = new NotificationDispatcher({
    // A lease must outlast one send, including the webhook timeout, or a slow
    // route lets another replica take the row mid-delivery.
    leaseMs: Math.max(DEFAULT_OUTBOX_LEASE_MS, config.requestTimeoutMs * 4),
    ...config.dispatcher,
    // Disabled notifications pause delivery of the existing backlog too.
    enabled: config.enabled,
    outbox,
    transport: primary,
    escalationTransport: escalation,
    logger: config.logger,
  });
  const notifier = new DurableNotifier({
    enabled: config.enabled,
    cooldownMs: config.cooldownMs,
    outbox,
    dispatcher,
    fallback: primary,
    logger: config.logger,
  });

  return { notifier, dispatcher, outbox };
}
