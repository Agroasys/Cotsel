/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'crypto';
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

function parseIsoTimestamp(value: string, field: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an ISO-8601 timestamp`, {
      field,
      value,
    });
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
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a non-negative number`, {
      field,
      value,
    });
  }

  return value;
}

export const SETTLEMENT_CALLBACK_CONTRACT_VERSION = 'cotsel.settlement-callback.v1';
export const SETTLEMENT_OBSERVED_AMOUNTS_SCHEMA_VERSION = 'cotsel.settlement-observed-amounts.v1';

const SETTLEMENT_AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const SETTLEMENT_TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const GASLESS_SPONSORSHIP_HANDOFF_PREFIX = 'gasless-sponsorship:';

export interface SettlementObservedAmounts {
  supplierPayoutUsd: string;
  treasuryClaimableUsd: string;
  buyerRefundUsd: string;
}

export interface SettlementReconciliationEvidence {
  schemaVersion: typeof SETTLEMENT_OBSERVED_AMOUNTS_SCHEMA_VERSION;
  observedAmounts: SettlementObservedAmounts;
}

export interface SettlementCallbackPayload extends Record<string, unknown> {
  contractVersion: typeof SETTLEMENT_CALLBACK_CONTRACT_VERSION;
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

function requireObservedAmount(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SETTLEMENT_AMOUNT_PATTERN.test(value)) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      `${field} must be a non-negative decimal string with at most two fractional digits`,
      { field },
    );
  }

  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const requiredKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== requiredKeys.length ||
    actualKeys.some((key, index) => key !== requiredKeys[index])
  ) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      `${field} must contain exactly: ${requiredKeys.join(', ')}`,
      { field },
    );
  }
}

function parseReconciliationEvidence(
  value: unknown,
  required: boolean,
): SettlementReconciliationEvidence | null {
  if (value === undefined && !required) {
    return null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'metadata.reconciliationEvidence is required for matched or drift reconciliation callbacks',
      { field: 'metadata.reconciliationEvidence' },
    );
  }

  const evidence = value as Record<string, unknown>;
  requireExactKeys(
    evidence,
    ['schemaVersion', 'observedAmounts'],
    'metadata.reconciliationEvidence',
  );
  if (evidence.schemaVersion !== SETTLEMENT_OBSERVED_AMOUNTS_SCHEMA_VERSION) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      `metadata.reconciliationEvidence.schemaVersion must be ${SETTLEMENT_OBSERVED_AMOUNTS_SCHEMA_VERSION}`,
      { field: 'metadata.reconciliationEvidence.schemaVersion' },
    );
  }

  const observed = evidence.observedAmounts;
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'metadata.reconciliationEvidence.observedAmounts is required',
      { field: 'metadata.reconciliationEvidence.observedAmounts' },
    );
  }

  const amounts = observed as Record<string, unknown>;
  requireExactKeys(
    amounts,
    ['supplierPayoutUsd', 'treasuryClaimableUsd', 'buyerRefundUsd'],
    'metadata.reconciliationEvidence.observedAmounts',
  );
  return {
    schemaVersion: SETTLEMENT_OBSERVED_AMOUNTS_SCHEMA_VERSION,
    observedAmounts: {
      supplierPayoutUsd: requireObservedAmount(
        amounts.supplierPayoutUsd,
        'metadata.reconciliationEvidence.observedAmounts.supplierPayoutUsd',
      ),
      treasuryClaimableUsd: requireObservedAmount(
        amounts.treasuryClaimableUsd,
        'metadata.reconciliationEvidence.observedAmounts.treasuryClaimableUsd',
      ),
      buyerRefundUsd: requireObservedAmount(
        amounts.buyerRefundUsd,
        'metadata.reconciliationEvidence.observedAmounts.buyerRefundUsd',
      ),
    },
  };
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
      assetAmount:
        input.assetAmount === undefined || input.assetAmount === null
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
    callbackDelivery: SettlementCallbackDeliveryRecord;
  }> {
    const observedAt = parseIsoTimestamp(input.observedAt, 'observedAt');
    const callbackEnabled = this.shouldQueueCallback();
    const dedupeKey = createHash('sha256')
      .update(`${input.handoffId}\n${input.eventType}\n${input.requestId}`)
      .digest('hex');

    return this.store.recordExecutionEvent(
      {
        ...input,
        observedAt,
        dedupeKey,
      },
      {
        targetUrl: callbackEnabled
          ? this.config.settlementCallbackUrl!
          : (this.config.settlementCallbackUrl ?? 'disabled://callback'),
        requestId: input.requestId,
        status: callbackEnabled ? 'pending' : 'disabled',
        nextAttemptAt: new Date().toISOString(),
        buildRequestBody: (handoff, event) => this.buildCallbackPayload(handoff, event),
      },
    );
  }

  async listExecutionEvents(handoffId: string): Promise<SettlementExecutionEventRecord[]> {
    return this.store.listExecutionEvents(requireNonEmpty(handoffId, 'handoffId'));
  }

  buildCallbackPayload(
    handoff: SettlementHandoffRecord,
    event: SettlementExecutionEventRecord,
  ): SettlementCallbackPayload {
    const isGaslessSponsorship = handoff.platformHandoffId.startsWith(
      GASLESS_SPONSORSHIP_HANDOFF_PREFIX,
    );
    const requiresObservedAmounts =
      !isGaslessSponsorship &&
      (handoff.reconciliationStatus === 'matched' ||
        handoff.reconciliationStatus === 'drift' ||
        event.eventType === 'reconciled' ||
        event.eventType === 'drift_detected');
    const reconciliationEvidence = parseReconciliationEvidence(
      event.metadata.reconciliationEvidence,
      requiresObservedAmounts,
    );
    if (requiresObservedAmounts && !/^\d+$/.test(handoff.tradeId)) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'tradeId must be the numeric on-chain trade identifier for reconciliation callbacks',
        { field: 'tradeId' },
      );
    }
    if (
      requiresObservedAmounts &&
      !SETTLEMENT_TRANSACTION_HASH_PATTERN.test(handoff.txHash ?? '')
    ) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'txHash must be the canonical release transaction hash for reconciliation callbacks',
        { field: 'txHash' },
      );
    }

    return {
      contractVersion: SETTLEMENT_CALLBACK_CONTRACT_VERSION,
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
        ...(reconciliationEvidence ? { reconciliationEvidence } : {}),
      },
    };
  }

  private shouldQueueCallback(): boolean {
    return (
      this.config.settlementCallbackEnabled &&
      Boolean(this.config.settlementCallbackUrl) &&
      Boolean(this.config.settlementCallbackApiKey) &&
      Boolean(this.config.settlementCallbackApiSecret)
    );
  }
}
