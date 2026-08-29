/**
 * SPDX-License-Identifier: Apache-2.0
 */
export const SETTLEMENT_EXECUTION_STATUSES = [
  'pending',
  'accepted',
  'queued',
  'broadcast_unknown',
  'confirmation_pending',
  'submitted',
  'confirmed',
  'reverted',
  'replaced',
  'failed',
  'rejected',
] as const;

export const SETTLEMENT_RECONCILIATION_STATUSES = [
  'pending',
  'matched',
  'drift',
  'unavailable',
] as const;

export const SETTLEMENT_CALLBACK_STATUSES = [
  'pending',
  'delivered',
  'failed',
  'dead_letter',
  'disabled',
] as const;

export const SETTLEMENT_EVENT_TYPES = [
  'accepted',
  'queued',
  'simulation_completed',
  'broadcast_unknown',
  'confirmation_pending',
  'submitted',
  'confirmed',
  'reverted',
  'replaced',
  'failed',
  'rejected',
  'reconciled',
  'drift_detected',
] as const;

export type SettlementExecutionStatus = (typeof SETTLEMENT_EXECUTION_STATUSES)[number];
export type SettlementReconciliationStatus = (typeof SETTLEMENT_RECONCILIATION_STATUSES)[number];
export type SettlementCallbackStatus = (typeof SETTLEMENT_CALLBACK_STATUSES)[number];
export type SettlementEventType = (typeof SETTLEMENT_EVENT_TYPES)[number];

export interface SettlementHandoffRecord {
  handoffId: string;
  platformId: string;
  platformHandoffId: string;
  tradeId: string;
  phase: string;
  settlementChannel: string;
  displayCurrency: string;
  displayAmount: number;
  assetSymbol: string | null;
  assetAmount: number | null;
  ricardianHash: string | null;
  externalReference: string | null;
  metadata: Record<string, unknown>;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  callbackStatus: SettlementCallbackStatus;
  providerStatus: string | null;
  txHash: string | null;
  latestEventId: string | null;
  latestEventType: SettlementEventType | null;
  latestEventDetail: string | null;
  latestEventAt: string | null;
  callbackDeliveredAt: string | null;
  requestId: string;
  sourceApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementExecutionEventRecord {
  eventId: string;
  handoffId: string;
  eventType: SettlementEventType;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  providerStatus: string | null;
  txHash: string | null;
  detail: string | null;
  metadata: Record<string, unknown>;
  observedAt: string;
  requestId: string;
  sourceApiKeyId: string | null;
  createdAt: string;
}

export interface SettlementCallbackDeliveryRecord {
  deliveryId: string;
  handoffId: string;
  eventId: string;
  targetUrl: string;
  requestBody: Record<string, unknown>;
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead_letter' | 'disabled';
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptedAt: string | null;
  deliveredAt: string | null;
  responseStatus: number | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  requestId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSettlementHandoffInput {
  platformId: string;
  platformHandoffId: string;
  tradeId: string;
  phase: string;
  settlementChannel: string;
  displayCurrency: string;
  displayAmount: number;
  assetSymbol?: string | null;
  assetAmount?: number | null;
  ricardianHash?: string | null;
  externalReference?: string | null;
  metadata?: Record<string, unknown>;
  requestId: string;
  sourceApiKeyId?: string | null;
}

export interface CreateSettlementExecutionEventInput {
  handoffId: string;
  eventType: SettlementEventType;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  providerStatus?: string | null;
  txHash?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown>;
  observedAt: string;
  requestId: string;
  sourceApiKeyId?: string | null;
}

export interface QueueSettlementCallbackInput {
  handoffId: string;
  eventId: string;
  targetUrl: string;
  requestBody: Record<string, unknown>;
  requestId: string;
  status: 'pending' | 'disabled';
  nextAttemptAt: string;
}

export interface PersistSettlementExecutionEventInput extends CreateSettlementExecutionEventInput {
  dedupeKey: string;
}

export interface SettlementCallbackPlan {
  targetUrl: string;
  requestId: string;
  status: 'pending' | 'disabled';
  nextAttemptAt: string;
  buildRequestBody: (
    handoff: SettlementHandoffRecord,
    event: SettlementExecutionEventRecord,
  ) => Record<string, unknown>;
}

export interface TradeSettlementProjection {
  handoffId: string;
  platformId: string;
  platformHandoffId: string;
  phase: string;
  settlementChannel: string;
  displayCurrency: string;
  displayAmount: number;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  callbackStatus: SettlementCallbackStatus;
  providerStatus: string | null;
  txHash: string | null;
  externalReference: string | null;
  latestEventType: SettlementEventType | null;
  latestEventDetail: string | null;
  latestEventAt: string | null;
  callbackDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListSettlementHandoffsInput {
  tradeId?: string;
  reconciliationStatus?: SettlementReconciliationStatus;
  executionStatus?: SettlementExecutionStatus;
  limit: number;
  offset: number;
}

export interface ListSettlementHandoffsResult {
  items: SettlementHandoffRecord[];
  total: number;
  sourceFreshAt: string | null;
}

export interface SettlementStore {
  createHandoff(input: CreateSettlementHandoffInput): Promise<SettlementHandoffRecord>;
  getHandoff(handoffId: string): Promise<SettlementHandoffRecord | null>;
  getHandoffByPlatformRef(
    platformId: string,
    platformHandoffId: string,
  ): Promise<SettlementHandoffRecord | null>;
  listHandoffs(input: ListSettlementHandoffsInput): Promise<ListSettlementHandoffsResult>;
  recordExecutionEvent(
    input: PersistSettlementExecutionEventInput,
    callback: SettlementCallbackPlan,
  ): Promise<{
    handoff: SettlementHandoffRecord;
    event: SettlementExecutionEventRecord;
    callbackDelivery: SettlementCallbackDeliveryRecord;
  }>;
  listExecutionEvents(handoffId: string): Promise<SettlementExecutionEventRecord[]>;
  getCallbackDelivery(deliveryId: string): Promise<SettlementCallbackDeliveryRecord | null>;
  getDueCallbackDeliveries(limit: number, now: string): Promise<SettlementCallbackDeliveryRecord[]>;
  markCallbackDelivering(
    deliveryId: string,
    leaseOwner: string,
    attemptedAt: string,
    leaseExpiresAt: string,
  ): Promise<SettlementCallbackDeliveryRecord | null>;
  markCallbackDelivered(
    deliveryId: string,
    leaseOwner: string,
    completedAt: string,
    responseStatus: number,
  ): Promise<boolean>;
  markCallbackFailed(
    deliveryId: string,
    leaseOwner: string,
    update: {
      attemptedAt: string;
      responseStatus?: number | null;
      errorMessage: string;
      nextAttemptAt: string;
      deadLetter: boolean;
    },
  ): Promise<boolean>;
  requeueCallbackDelivery(
    deliveryId: string,
    nextAttemptAt: string,
  ): Promise<SettlementCallbackDeliveryRecord | null>;
  getTradeSettlementProjectionMap(
    tradeIds: string[],
  ): Promise<Map<string, TradeSettlementProjection>>;
}
