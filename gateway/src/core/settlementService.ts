/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';
import {
  CreateSettlementExecutionEventInput,
  CreateSettlementHandoffInput,
  SettlementCallbackDeliveryRecord,
  SettlementEventType,
  SettlementExecutionEventRecord,
  SettlementExecutionStatus,
  SettlementHandoffRecord,
  SettlementReconciliationStatus,
  SettlementStore,
} from './settlementStore';
import { validateExecutionTransition } from './settlementStateMachine';

function parseIsoTimestamp(value: string, field: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an ISO-8601 timestamp`, { field, value });
  }

  return timestamp.toISOString();
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} is required`);
  }

  return trimmed;
}

function validateAmount(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a non-negative number`, { field, value });
  }

  return value;
}

export interface SettlementCallbackPayload extends Record<string, unknown> {
  eventId: string;
  handoffId: string;
  platformId: string;
  platformHandoffId: string;
  tradeId: string;
  phase: string;
  settlementChannel: string;
  displayCurrency: string;
  displayAmount: number;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  callbackStatus: string;
  providerStatus: string | null;
  txHash: string | null;
  latestEventType: SettlementEventType | null;
  latestEventDetail: string | null;
  latestEventAt: string | null;
  observedAt: string;
  metadata: Record<string, unknown>;
}

export class SettlementService {
  constructor(
    private readonly config: GatewayConfig,
    private readonly store: SettlementStore,
  ) {}

  async createHandoff(input: CreateSettlementHandoffInput): Promise<SettlementHandoffRecord> {
    return this.store.createHandoff({
      ...input,
      platformId: requireNonEmpty(input.platformId, 'platformId'),
      platformHandoffId: requireNonEmpty(input.platformHandoffId, 'platformHandoffId'),
      tradeId: requireNonEmpty(input.tradeId, 'tradeId'),
      phase: requireNonEmpty(input.phase, 'phase'),
      settlementChannel: requireNonEmpty(input.settlementChannel, 'settlementChannel'),
      displayCurrency: requireNonEmpty(input.displayCurrency, 'displayCurrency'),
      displayAmount: validateAmount(input.displayAmount, 'displayAmount'),
      assetAmount: input.assetAmount === undefined || input.assetAmount === null
        ? null
        : validateAmount(input.assetAmount, 'assetAmount'),
      ricardianHash: input.ricardianHash?.trim() || null,
      externalReference: input.externalReference?.trim() || null,
      metadata: input.metadata ?? {},
    });
  }

  async recordExecutionEvent(input: CreateSettlementExecutionEventInput): Promise<{
    handoff: SettlementHandoffRecord;
    event: SettlementExecutionEventRecord;
    callbackDelivery: SettlementCallbackDeliveryRecord | null;
  }> {
    const handoff = await this.store.getHandoff(input.handoffId);
    if (!handoff) {
      throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', { handoffId: input.handoffId });
    }

    validateExecutionTransition(handoff.executionStatus, input.executionStatus, input.eventType);
    const observedAt = parseIsoTimestamp(input.observedAt, 'observedAt');

    const event = await this.store.createExecutionEvent({
      ...input,
      observedAt,
    });

    const updatedHandoff = await this.store.getHandoff(input.handoffId);
    if (!updatedHandoff) {
      throw new GatewayError(500, 'INTERNAL_ERROR', 'Settlement handoff disappeared after event persistence', {
        handoffId: input.handoffId,
      });
    }

    let callbackDelivery: SettlementCallbackDeliveryRecord | null = null;
    if (this.shouldQueueCallback()) {
      callbackDelivery = await this.store.queueCallbackDelivery({
        handoffId: updatedHandoff.handoffId,
        eventId: event.eventId,
        targetUrl: this.config.settlementCallbackUrl!,
        requestBody: this.buildCallbackPayload(updatedHandoff, event),
        requestId: input.requestId,
        status: 'pending',
        nextAttemptAt: new Date().toISOString(),
      });
    } else {
      callbackDelivery = await this.store.queueCallbackDelivery({
        handoffId: updatedHandoff.handoffId,
        eventId: event.eventId,
        targetUrl: this.config.settlementCallbackUrl ?? 'disabled://callback',
        requestBody: this.buildCallbackPayload(updatedHandoff, event),
        requestId: input.requestId,
        status: 'disabled',
        nextAttemptAt: new Date().toISOString(),
      });
    }

    return {
      handoff: updatedHandoff,
      event,
      callbackDelivery,
    };
  }

  async listExecutionEvents(handoffId: string): Promise<SettlementExecutionEventRecord[]> {
    return this.store.listExecutionEvents(requireNonEmpty(handoffId, 'handoffId'));
  }

  buildCallbackPayload(handoff: SettlementHandoffRecord, event: SettlementExecutionEventRecord): SettlementCallbackPayload {
    return {
      eventId: event.eventId,
      handoffId: handoff.handoffId,
      platformId: handoff.platformId,
      platformHandoffId: handoff.platformHandoffId,
      tradeId: handoff.tradeId,
      phase: handoff.phase,
      settlementChannel: handoff.settlementChannel,
      displayCurrency: handoff.displayCurrency,
      displayAmount: handoff.displayAmount,
      executionStatus: handoff.executionStatus,
      reconciliationStatus: handoff.reconciliationStatus,
      callbackStatus: handoff.callbackStatus,
      providerStatus: handoff.providerStatus,
      txHash: handoff.txHash,
      latestEventType: handoff.latestEventType,
      latestEventDetail: handoff.latestEventDetail,
      latestEventAt: handoff.latestEventAt,
      observedAt: event.observedAt,
      metadata: {
        ...handoff.metadata,
        event: event.metadata,
      },
    };
  }

  private shouldQueueCallback(): boolean {
    return this.config.settlementCallbackEnabled
      && Boolean(this.config.settlementCallbackUrl)
      && Boolean(this.config.settlementCallbackApiKey)
      && Boolean(this.config.settlementCallbackApiSecret);
  }
}
