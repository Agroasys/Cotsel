import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { NotificationEvent, NotificationLogger, NotificationTransport } from './index';
import {
  sanitizeDeliveryError,
  type ClaimedEscalation,
  type ClaimedNotification,
  type NotificationOutbox,
  type OutboxStats,
} from './outbox';

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;
export const DEFAULT_OUTBOX_RETRY_BASE_DELAY_MS = 5_000;
export const DEFAULT_OUTBOX_RETRY_MAX_DELAY_MS = 300_000;
export const DEFAULT_OUTBOX_ESCALATE_AFTER_MS = 600_000;
export const DEFAULT_OUTBOX_DISPATCH_INTERVAL_MS = 15_000;
export const DEFAULT_OUTBOX_LEASE_MS = 60_000;
export const DEFAULT_OUTBOX_BATCH_SIZE = 50;

export const NOTIFICATION_ESCALATION_TYPE = 'NOTIFICATION_ESCALATION';

export interface NotificationDispatcherConfig {
  outbox: NotificationOutbox;
  /**
   * When false the dispatcher sends nothing and leaves every queued row as it
   * is, so disabling notifications pauses delivery without consuming attempts
   * or discarding the backlog. Defaults to true.
   */
  enabled?: boolean;
  /** The primary severity route. */
  transport: NotificationTransport;
  /**
   * The duty-owner route for critical notifications the primary route could
   * not deliver. Without one, an undeliverable critical alert is still kept and
   * reported, but nobody is paged about it.
   */
  escalationTransport?: NotificationTransport;
  /** Names this dispatcher in leases; defaults to host, pid and a random suffix. */
  owner?: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  escalateAfterMs?: number;
  intervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  logger?: NotificationLogger;
}

export interface DispatchSummary {
  delivered: number;
  retried: number;
  deadLettered: number;
  escalated: number;
  escalationFailed: number;
}

const consoleLogger: NotificationLogger = {
  info: (message, meta) => console.log(JSON.stringify({ level: 'info', message, ...meta })),
  warn: (message, meta) => console.warn(JSON.stringify({ level: 'warn', message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

/** Exponential backoff for the attempt that just failed, capped. */
export function outboxRetryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.min(30, Math.max(0, attempt - 1));
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * The page sent to the duty owner. It names the original alert and why it
 * escalated, and carries the original correlation so the owner can find it.
 */
export function buildEscalationEvent(escalation: ClaimedEscalation): NotificationEvent {
  const original = escalation.event;
  const why =
    escalation.reason === 'DEAD_LETTER'
      ? 'exhausted its delivery attempts and was dead-lettered'
      : 'is still undelivered past the escalation deadline';

  return {
    source: original.source,
    type: NOTIFICATION_ESCALATION_TYPE,
    severity: 'critical',
    dedupKey: `escalation:${escalation.id}`,
    message: `Critical ${original.type} alert ${why}. The primary route did not confirm delivery; respond to the original alert below.`,
    correlation: original.correlation,
    metadata: {
      outboxId: escalation.id,
      escalationReason: escalation.reason,
      originalType: original.type,
      originalMessage: original.message,
      originalDedupKey: original.dedupKey,
      deliveryAttempts: escalation.attempts,
      occurrences: escalation.occurrences,
      lastError: escalation.lastError === null ? null : sanitizeDeliveryError(escalation.lastError),
      firstRaisedAt: new Date(escalation.createdAt).toISOString(),
    },
  };
}

/**
 * Drains the notification outbox: delivers, backs off, dead-letters and
 * escalates.
 *
 * Delivery is at-least-once. A dispatcher that dies after the webhook accepted
 * a notification but before recording it will send that notification again
 * when the lease expires; a duplicate page is the safe failure, a lost one is
 * not.
 */
export class NotificationDispatcher {
  readonly owner: string;
  readonly maxAttempts: number;
  readonly escalateAfterMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly logger: NotificationLogger;
  private inFlight: Promise<DispatchSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reportedDisabled = false;

  constructor(private readonly config: NotificationDispatcherConfig) {
    this.owner = config.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.maxAttempts = positive(config.maxAttempts, DEFAULT_OUTBOX_MAX_ATTEMPTS);
    this.retryBaseDelayMs = positive(config.retryBaseDelayMs, DEFAULT_OUTBOX_RETRY_BASE_DELAY_MS);
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      positive(config.retryMaxDelayMs, DEFAULT_OUTBOX_RETRY_MAX_DELAY_MS),
    );
    this.escalateAfterMs = positive(config.escalateAfterMs, DEFAULT_OUTBOX_ESCALATE_AFTER_MS);
    this.intervalMs = positive(config.intervalMs, DEFAULT_OUTBOX_DISPATCH_INTERVAL_MS);
    this.leaseMs = positive(config.leaseMs, DEFAULT_OUTBOX_LEASE_MS);
    this.batchSize = positive(config.batchSize, DEFAULT_OUTBOX_BATCH_SIZE);
    this.logger = config.logger ?? consoleLogger;
  }

  /**
   * One drain pass. Concurrent callers share the pass already running rather
   * than racing it, so a producer can kick delivery without coordinating with
   * the timer.
   */
  runOnce(): Promise<DispatchSummary> {
    if (!this.inFlight) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error('Notification outbox pass failed', { error: errorMessage(error) });
      });
    }, this.intervalMs);
    this.timer.unref();
    void this.runOnce().catch((error: unknown) => {
      this.logger.error('Notification outbox pass failed', { error: errorMessage(error) });
    });
  }

  /** Stop the timer and let the pass already running finish. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => undefined);
  }

  stats(): Promise<OutboxStats> {
    return this.config.outbox.stats(this.escalateAfterMs);
  }

  private async drain(): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      escalated: 0,
      escalationFailed: 0,
    };

    if (this.config.enabled === false) {
      await this.reportDisabled();
      return summary;
    }

    const { outbox } = this.config;
    summary.deadLettered += await outbox.deadLetterExhausted(this.maxAttempts);

    // One row is claimed immediately before its send, never a batch up front:
    // a batch leased together would spend its lease waiting behind earlier
    // sends, and a replica could then reclaim and deliver rows this pass still
    // goes on to send.
    const attempted: string[] = [];
    for (let sent = 0; sent < this.batchSize; sent += 1) {
      const [row] = await outbox.claimDue({
        owner: this.owner,
        leaseMs: this.leaseMs,
        limit: 1,
        maxAttempts: this.maxAttempts,
        excludeIds: attempted,
      });
      if (!row) {
        break;
      }
      attempted.push(row.id);
      await this.deliverClaimed(row, summary);
    }

    await this.escalate(summary);
    return summary;
  }

  private async reportDisabled(): Promise<void> {
    if (this.reportedDisabled) {
      return;
    }
    this.reportedDisabled = true;
    const { pending, deadLetters } = await this.config.outbox.stats(this.escalateAfterMs);
    if (pending > 0 || deadLetters > 0) {
      this.logger.warn('Notifications are disabled; queued notifications are retained unsent', {
        pending,
        deadLetters,
      });
    }
  }

  private async deliverClaimed(row: ClaimedNotification, summary: DispatchSummary): Promise<void> {
    const { outbox } = this.config;
    try {
      await this.config.transport.deliver(row.event);
    } catch (error: unknown) {
      const message = errorMessage(error);
      const state = await outbox.markFailed({
        id: row.id,
        owner: this.owner,
        error: message,
        retryDelayMs: outboxRetryDelayMs(row.attempts, this.retryBaseDelayMs, this.retryMaxDelayMs),
        maxAttempts: this.maxAttempts,
      });
      const meta = {
        outboxId: row.id,
        source: row.event.source,
        type: row.event.type,
        severity: row.event.severity,
        attempt: row.attempts,
        maxAttempts: this.maxAttempts,
        error: sanitizeDeliveryError(message),
      };
      if (state === 'DEAD_LETTER') {
        summary.deadLettered += 1;
        this.logger.error('Notification dead-lettered after exhausting delivery attempts', meta);
      } else {
        summary.retried += 1;
        this.logger.warn('Notification delivery failed; it stays queued for retry', meta);
      }
      return;
    }

    if (await outbox.markDelivered(row.id, this.owner)) {
      summary.delivered += 1;
      this.logger.info('Notification delivered from outbox', {
        outboxId: row.id,
        source: row.event.source,
        type: row.event.type,
        severity: row.event.severity,
        attempt: row.attempts,
      });
    } else {
      this.logger.warn('Notification delivered after its outbox lease was lost', {
        outboxId: row.id,
        type: row.event.type,
      });
    }
  }

  private async escalate(summary: DispatchSummary): Promise<void> {
    const { outbox, escalationTransport } = this.config;

    if (!escalationTransport) {
      const { awaitingEscalation } = await outbox.stats(this.escalateAfterMs);
      if (awaitingEscalation > 0) {
        this.logger.error(
          'Critical notifications need escalation but no escalation route is configured',
          { awaitingEscalation, escalateAfterMs: this.escalateAfterMs },
        );
      }
      return;
    }

    const attempted: string[] = [];
    for (let sent = 0; sent < this.batchSize; sent += 1) {
      const [escalation] = await outbox.claimEscalations({
        escalateAfterMs: this.escalateAfterMs,
        leaseMs: this.leaseMs,
        limit: 1,
        excludeIds: attempted,
      });
      if (!escalation) {
        break;
      }
      attempted.push(escalation.id);
      try {
        await escalationTransport.deliver(buildEscalationEvent(escalation));
        await outbox.markEscalated(escalation.id, escalation.reason);
        summary.escalated += 1;
        this.logger.warn('Critical notification escalated to the duty owner', {
          outboxId: escalation.id,
          type: escalation.event.type,
          reason: escalation.reason,
        });
      } catch (error: unknown) {
        const message = errorMessage(error);
        await outbox.markEscalationFailed(
          escalation.id,
          message,
          outboxRetryDelayMs(1, this.retryBaseDelayMs, this.retryMaxDelayMs),
        );
        summary.escalationFailed += 1;
        this.logger.error('Could not escalate a critical notification; it will be retried', {
          outboxId: escalation.id,
          type: escalation.event.type,
          reason: escalation.reason,
          error: sanitizeDeliveryError(message),
        });
      }
    }
  }
}
