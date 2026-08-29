/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { GatewayConfig } from '../config/env';
import { Logger } from '../logging/logger';
import { SettlementStore } from './settlementStore';
import { createServiceAuthHeaders } from './serviceAuth';
import type { GatewayErrorHandlerWorkflow } from './errorHandlerWorkflow';

interface CallbackDispatcherOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  failedOperationWorkflow?: GatewayErrorHandlerWorkflow;
  workerId?: string;
}

function computeBackoffMs(
  attemptCount: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
): number {
  const backoff = initialBackoffMs * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(maxBackoffMs, backoff);
}

export class SettlementCallbackDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly failedOperationWorkflow?: GatewayErrorHandlerWorkflow;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: GatewayConfig,
    private readonly store: SettlementStore,
    options: CallbackDispatcherOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.failedOperationWorkflow = options.failedOperationWorkflow;
    this.workerId = options.workerId ?? randomUUID();
    this.leaseDurationMs = Math.max(30_000, this.config.settlementCallbackRequestTimeoutMs * 2);
  }

  start(): void {
    if (!this.config.settlementCallbackEnabled || this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.processDueDeliveries();
    }, this.config.settlementCallbackPollIntervalMs);

    void this.processDueDeliveries();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async processDueDeliveries(limit = 25): Promise<void> {
    if (this.running || !this.config.settlementCallbackEnabled) {
      return;
    }

    this.running = true;
    try {
      const due = await this.store.getDueCallbackDeliveries(limit, this.now().toISOString());
      for (const delivery of due) {
        await this.processDelivery(delivery.deliveryId);
      }
    } finally {
      this.running = false;
    }
  }

  async replayDeadLetterDelivery(deliveryId: string): Promise<void> {
    const requeued = await this.store.requeueCallbackDelivery(deliveryId, this.now().toISOString());
    if (!requeued) {
      throw new Error(`Settlement callback delivery is not eligible for replay: ${deliveryId}`);
    }

    await this.processDelivery(deliveryId);
  }

  private async processDelivery(deliveryId: string): Promise<void> {
    const attemptedAtDate = this.now();
    const attemptedAt = attemptedAtDate.toISOString();
    const leaseExpiresAt = new Date(attemptedAtDate.getTime() + this.leaseDurationMs).toISOString();
    const delivery = await this.store.markCallbackDelivering(
      deliveryId,
      this.workerId,
      attemptedAt,
      leaseExpiresAt,
    );
    if (!delivery) {
      return;
    }

    try {
      const callbackUrl = this.config.settlementCallbackUrl!;
      const payload = delivery.requestBody;
      const url = new URL(callbackUrl);
      const headers = createServiceAuthHeaders({
        apiKey: this.config.settlementCallbackApiKey!,
        apiSecret: this.config.settlementCallbackApiSecret!,
        method: 'POST',
        path: url.pathname,
        query: url.search,
        body: payload,
      });

      const response = await this.fetchImpl(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': delivery.requestId,
          ...headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.settlementCallbackRequestTimeoutMs),
      });

      if (response.ok) {
        const completed = await this.store.markCallbackDelivered(
          deliveryId,
          this.workerId,
          this.now().toISOString(),
          response.status,
        );
        if (!completed) {
          Logger.warn('Settlement callback completion ignored after lease ownership changed', {
            deliveryId,
            handoffId: delivery.handoffId,
            eventId: delivery.eventId,
          });
          return;
        }
        Logger.info('Settlement callback delivered', {
          deliveryId,
          handoffId: delivery.handoffId,
          eventId: delivery.eventId,
          responseStatus: response.status,
        });
        return;
      }

      await this.scheduleFailure(delivery, `HTTP ${response.status}`, response.status);
    } catch (error) {
      await this.scheduleFailure(
        delivery,
        error instanceof Error ? error.message : String(error),
        null,
      );
    }
  }

  private async scheduleFailure(
    delivery: { deliveryId: string; handoffId: string; eventId: string; attemptCount: number },
    message: string,
    responseStatus: number | null,
  ): Promise<void> {
    const deadLetter = delivery.attemptCount >= this.config.settlementCallbackMaxAttempts;
    const nextAttemptAt = new Date(
      this.now().getTime() +
        computeBackoffMs(
          delivery.attemptCount,
          this.config.settlementCallbackInitialBackoffMs,
          this.config.settlementCallbackMaxBackoffMs,
        ),
    ).toISOString();

    const updated = await this.store.markCallbackFailed(delivery.deliveryId, this.workerId, {
      attemptedAt: this.now().toISOString(),
      responseStatus,
      errorMessage: message,
      nextAttemptAt,
      deadLetter,
    });
    if (!updated) {
      Logger.warn('Settlement callback failure ignored after lease ownership changed', {
        deliveryId: delivery.deliveryId,
        handoffId: delivery.handoffId,
        eventId: delivery.eventId,
      });
      return;
    }

    Logger.warn('Settlement callback delivery failed', {
      deliveryId: delivery.deliveryId,
      handoffId: delivery.handoffId,
      eventId: delivery.eventId,
      responseStatus,
      deadLetter,
      error: message,
    });

    if (deadLetter && this.failedOperationWorkflow) {
      const callbackDelivery = await this.store.getCallbackDelivery(delivery.deliveryId);
      if (callbackDelivery) {
        await this.failedOperationWorkflow.captureSettlementCallbackDeadLetter({
          deliveryId: callbackDelivery.deliveryId,
          handoffId: callbackDelivery.handoffId,
          eventId: callbackDelivery.eventId,
          targetUrl: callbackDelivery.targetUrl,
          requestId: callbackDelivery.requestId,
          requestPayload: callbackDelivery.requestBody,
          responseStatus,
          errorMessage: message,
        });
      }
    }
  }
}
