export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationSeverityRoute = 'informational' | 'operations' | 'pager';

export const NOTIFICATION_ROUTING_VERSION = '2026-02-21';
export const DEFAULT_TEMPLATE_VERSION = 'generic-v1';

export const NOTIFICATION_TEMPLATE_VERSIONS: Record<string, string> = {
  ORACLE_TRIGGER_TERMINAL_FAILURE: 'oracle-terminal-v1',
  ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE: 'oracle-redrive-v1',
  ORACLE_CONFIRMATION_TIMEOUT: 'oracle-confirmation-timeout-v1',
  RECONCILIATION_CRITICAL_DRIFT: 'reconciliation-critical-drift-v1',
};

export interface NotificationEvent {
  source: 'oracle' | 'reconciliation' | string;
  type: string;
  severity: NotificationSeverity;
  dedupKey: string;
  message: string;
  correlation: {
    tradeId?: string;
    actionKey?: string;
    requestId?: string;
    txHash?: string;
    runKey?: string;
    mismatchCode?: string;
  };
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WebhookNotifierConfig {
  enabled: boolean;
  webhookUrl?: string;
  cooldownMs: number;
  requestTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

interface SlackPayload {
  text: string;
  attachments: Array<{
    color: string;
    fields: Array<{
      title: string;
      value: string;
      short: boolean;
    }>;
  }>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_ATTEMPTS = 0;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 2000;
const MAX_RETRY_ATTEMPTS_CAP = 5;

export class WebhookNotifier {
  private readonly dedupCache = new Map<string, number>();

  constructor(private readonly config: WebhookNotifierConfig) {}

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    if (this.config.logger) {
      this.config.logger.info(message, meta);
      return;
    }

    console.log(JSON.stringify({ level: 'info', message, ...meta }));
  }

  private logWarn(message: string, meta?: Record<string, unknown>): void {
    if (this.config.logger) {
      this.config.logger.warn(message, meta);
      return;
    }

    console.warn(JSON.stringify({ level: 'warn', message, ...meta }));
  }

  private logError(message: string, meta?: Record<string, unknown>): void {
    if (this.config.logger) {
      this.config.logger.error(message, meta);
      return;
    }

    console.error(JSON.stringify({ level: 'error', message, ...meta }));
  }

  private colorForSeverity(severity: NotificationSeverity): string {
    if (severity === 'critical') return '#d32f2f';
    if (severity === 'warning') return '#f57c00';
    return '#1976d2';
  }

  private severityRouteForSeverity(severity: NotificationSeverity): NotificationSeverityRoute {
    if (severity === 'critical') return 'pager';
    if (severity === 'warning') return 'operations';
    return 'informational';
  }

  private templateVersionForType(type: string): string {
    return NOTIFICATION_TEMPLATE_VERSIONS[type] ?? DEFAULT_TEMPLATE_VERSION;
  }

  private normalizeRetryAttempts(): number {
    const configured = this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    const normalized = Math.trunc(configured);
    if (normalized <= 0) {
      return 0;
    }

    return Math.min(normalized, MAX_RETRY_ATTEMPTS_CAP);
  }

  private normalizeRetryDelayMs(): number {
    const configured = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    return Math.max(0, Math.trunc(configured));
  }

  private normalizeMaxRetryDelayMs(baseDelayMs: number): number {
    const configured = this.config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const normalized = Math.max(0, Math.trunc(configured));
    return Math.max(baseDelayMs, normalized);
  }

  private retryDelayForAttempt(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponent = Math.max(0, attempt - 1);
    const delay = baseDelayMs * Math.pow(2, exponent);
    return Math.min(delay, maxDelayMs);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isInCooldown(dedupKey: string): boolean {
    const now = Date.now();
    const previousTimestamp = this.dedupCache.get(dedupKey);

    return Boolean(previousTimestamp && now - previousTimestamp < this.config.cooldownMs);
  }

  private markSent(dedupKey: string): void {
    this.dedupCache.set(dedupKey, Date.now());
  }

  private toSlackPayload(event: NotificationEvent): SlackPayload {
    const templateVersion = this.templateVersionForType(event.type);
    const severityRoute = this.severityRouteForSeverity(event.severity);
    const correlationRows: Array<[string, string | undefined]> = [
      ['tradeId', event.correlation.tradeId],
      ['actionKey', event.correlation.actionKey],
      ['requestId', event.correlation.requestId],
      ['txHash', event.correlation.txHash],
      ['runKey', event.correlation.runKey],
      ['mismatchCode', event.correlation.mismatchCode],
      ['templateVersion', templateVersion],
      ['severityRoute', severityRoute],
      ['routingVersion', NOTIFICATION_ROUTING_VERSION],
    ];

    const fields = correlationRows
      .filter(([, value]) => Boolean(value))
      .map(([title, value]) => ({
        title,
        value: value as string,
        short: true,
      }));

    return {
      text: `[${event.source}] ${event.type} (${event.severity})`,
      attachments: [
        {
          color: this.colorForSeverity(event.severity),
          fields: [{ title: 'message', value: event.message, short: false }, ...fields],
        },
      ],
    };
  }

  async notify(event: NotificationEvent): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    if (!this.config.webhookUrl) {
      this.logWarn('Notification dropped because webhook URL is not configured', {
        source: event.source,
        type: event.type,
      });
      return false;
    }

    if (this.isInCooldown(event.dedupKey)) {
      this.logInfo('Notification suppressed by cooldown dedup', {
        dedupKey: event.dedupKey,
        cooldownMs: this.config.cooldownMs,
      });
      return false;
    }

    const payload = this.toSlackPayload(event);
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retryAttempts = this.normalizeRetryAttempts();
    const baseDelayMs = this.normalizeRetryDelayMs();
    const maxDelayMs = this.normalizeMaxRetryDelayMs(baseDelayMs);
    const totalAttempts = retryAttempts + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        timeoutController.abort();
      }, timeoutMs);

      try {
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: timeoutController.signal,
        });

        if (response.ok) {
          this.markSent(event.dedupKey);

          this.logInfo('Notification sent', {
            source: event.source,
            type: event.type,
            severity: event.severity,
            attempt,
            totalAttempts,
          });

          return true;
        }

        this.logError('Notification webhook request failed', {
          status: response.status,
          statusText: response.statusText,
          source: event.source,
          type: event.type,
          attempt,
          totalAttempts,
        });
      } catch (error: unknown) {
        this.logError('Notification webhook request errored', {
          error: error instanceof Error ? error.message : error,
          source: event.source,
          type: event.type,
          attempt,
          totalAttempts,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (attempt < totalAttempts) {
        const delayMs = this.retryDelayForAttempt(attempt, baseDelayMs, maxDelayMs);
        this.logWarn('Retrying notification delivery', {
          source: event.source,
          type: event.type,
          dedupKey: event.dedupKey,
          nextAttempt: attempt + 1,
          totalAttempts,
          delayMs,
        });
        await this.sleep(delayMs);
      }
    }

    return false;
  }
}
