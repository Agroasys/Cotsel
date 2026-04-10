/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { GatewayError } from '../errors';
import { validateExecutionTransition } from './settlementStateMachine';

export const SETTLEMENT_EXECUTION_STATUSES = [
  'pending',
  'accepted',
  'queued',
  'submitted',
  'confirmed',
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
  'submitted',
  'confirmed',
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
  createExecutionEvent(
    input: CreateSettlementExecutionEventInput,
  ): Promise<SettlementExecutionEventRecord>;
  listExecutionEvents(handoffId: string): Promise<SettlementExecutionEventRecord[]>;
  queueCallbackDelivery(
    input: QueueSettlementCallbackInput,
  ): Promise<SettlementCallbackDeliveryRecord>;
  getCallbackDelivery(deliveryId: string): Promise<SettlementCallbackDeliveryRecord | null>;
  getDueCallbackDeliveries(limit: number, now: string): Promise<SettlementCallbackDeliveryRecord[]>;
  markCallbackDelivering(
    deliveryId: string,
    attemptedAt: string,
  ): Promise<SettlementCallbackDeliveryRecord | null>;
  markCallbackDelivered(
    deliveryId: string,
    completedAt: string,
    responseStatus: number,
  ): Promise<void>;
  markCallbackFailed(
    deliveryId: string,
    update: {
      attemptedAt: string;
      responseStatus?: number | null;
      errorMessage: string;
      nextAttemptAt: string;
      deadLetter: boolean;
    },
  ): Promise<void>;
  requeueCallbackDelivery(
    deliveryId: string,
    nextAttemptAt: string,
  ): Promise<SettlementCallbackDeliveryRecord | null>;
  getTradeSettlementProjectionMap(
    tradeIds: string[],
  ): Promise<Map<string, TradeSettlementProjection>>;
}

interface SettlementHandoffRow {
  handoffId: string;
  platformId: string;
  platformHandoffId: string;
  tradeId: string;
  phase: string;
  settlementChannel: string;
  displayCurrency: string;
  displayAmount: string;
  assetSymbol: string | null;
  assetAmount: string | null;
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
  latestEventAt: Date | null;
  callbackDeliveredAt: Date | null;
  requestId: string;
  sourceApiKeyId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SettlementExecutionEventRow {
  eventId: string;
  handoffId: string;
  eventType: SettlementEventType;
  executionStatus: SettlementExecutionStatus;
  reconciliationStatus: SettlementReconciliationStatus;
  providerStatus: string | null;
  txHash: string | null;
  detail: string | null;
  metadata: Record<string, unknown>;
  observedAt: Date;
  requestId: string;
  sourceApiKeyId: string | null;
  createdAt: Date;
}

interface SettlementCallbackDeliveryRow {
  deliveryId: string;
  handoffId: string;
  eventId: string;
  targetUrl: string;
  requestBody: Record<string, unknown>;
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead_letter' | 'disabled';
  attemptCount: number;
  nextAttemptAt: Date;
  lastAttemptedAt: Date | null;
  deliveredAt: Date | null;
  responseStatus: number | null;
  lastError: string | null;
  requestId: string;
  createdAt: Date;
  updatedAt: Date;
}

function parseDecimal(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Stored settlement numeric value is invalid', {
      value,
    });
  }

  return parsed;
}

function mapHandoffRow(row: SettlementHandoffRow): SettlementHandoffRecord {
  return {
    handoffId: row.handoffId,
    platformId: row.platformId,
    platformHandoffId: row.platformHandoffId,
    tradeId: row.tradeId,
    phase: row.phase,
    settlementChannel: row.settlementChannel,
    displayCurrency: row.displayCurrency,
    displayAmount: parseDecimal(row.displayAmount) ?? 0,
    assetSymbol: row.assetSymbol,
    assetAmount: parseDecimal(row.assetAmount),
    ricardianHash: row.ricardianHash,
    externalReference: row.externalReference,
    metadata: row.metadata || {},
    executionStatus: row.executionStatus,
    reconciliationStatus: row.reconciliationStatus,
    callbackStatus: row.callbackStatus,
    providerStatus: row.providerStatus,
    txHash: row.txHash,
    latestEventId: row.latestEventId,
    latestEventType: row.latestEventType,
    latestEventDetail: row.latestEventDetail,
    latestEventAt: row.latestEventAt ? row.latestEventAt.toISOString() : null,
    callbackDeliveredAt: row.callbackDeliveredAt ? row.callbackDeliveredAt.toISOString() : null,
    requestId: row.requestId,
    sourceApiKeyId: row.sourceApiKeyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapEventRow(row: SettlementExecutionEventRow): SettlementExecutionEventRecord {
  return {
    eventId: row.eventId,
    handoffId: row.handoffId,
    eventType: row.eventType,
    executionStatus: row.executionStatus,
    reconciliationStatus: row.reconciliationStatus,
    providerStatus: row.providerStatus,
    txHash: row.txHash,
    detail: row.detail,
    metadata: row.metadata || {},
    observedAt: row.observedAt.toISOString(),
    requestId: row.requestId,
    sourceApiKeyId: row.sourceApiKeyId,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapDeliveryRow(row: SettlementCallbackDeliveryRow): SettlementCallbackDeliveryRecord {
  return {
    deliveryId: row.deliveryId,
    handoffId: row.handoffId,
    eventId: row.eventId,
    targetUrl: row.targetUrl,
    requestBody: row.requestBody || {},
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastAttemptedAt: row.lastAttemptedAt ? row.lastAttemptedAt.toISOString() : null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildHandoffFilterClause(
  input: Pick<ListSettlementHandoffsInput, 'tradeId' | 'reconciliationStatus' | 'executionStatus'>,
): { clause: string; params: string[] } {
  const filters: string[] = [];
  const params: string[] = [];

  if (input.tradeId) {
    params.push(input.tradeId);
    filters.push(`trade_id = $${params.length}`);
  }

  if (input.reconciliationStatus) {
    params.push(input.reconciliationStatus);
    filters.push(`reconciliation_status = $${params.length}`);
  }

  if (input.executionStatus) {
    params.push(input.executionStatus);
    filters.push(`execution_status = $${params.length}`);
  }

  return {
    clause: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '',
    params,
  };
}

async function cleanupExpiredNonces(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM service_auth_nonces WHERE expires_at < NOW()');
}

async function createEventWithClient(
  client: PoolClient,
  input: CreateSettlementExecutionEventInput,
): Promise<SettlementExecutionEventRecord> {
  const eventId = randomUUID();
  const insertEvent = await client.query<SettlementExecutionEventRow>(
    `INSERT INTO settlement_execution_events (
       event_id,
       handoff_id,
       event_type,
       execution_status,
     reconciliation_status,
     provider_status,
     tx_hash,
     detail,
     metadata,
     observed_at,
     request_id,
     source_api_key_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
     RETURNING
       event_id AS "eventId",
       handoff_id AS "handoffId",
       event_type AS "eventType",
       execution_status AS "executionStatus",
       reconciliation_status AS "reconciliationStatus",
       provider_status AS "providerStatus",
       tx_hash AS "txHash",
       detail,
       metadata,
       observed_at AS "observedAt",
       request_id AS "requestId",
       source_api_key_id AS "sourceApiKeyId",
       created_at AS "createdAt"`,
    [
      eventId,
      input.handoffId,
      input.eventType,
      input.executionStatus,
      input.reconciliationStatus,
      input.providerStatus ?? null,
      input.txHash ?? null,
      input.detail ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.observedAt,
      input.requestId,
      input.sourceApiKeyId ?? null,
    ],
  );

  const event = insertEvent.rows[0];
  if (!event) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Failed to persist settlement execution event');
  }

  await client.query(
    `UPDATE settlement_handoffs
     SET execution_status = $2,
         reconciliation_status = $3,
         callback_status = CASE
           WHEN callback_status = 'disabled' THEN callback_status
           ELSE 'pending'
         END,
         provider_status = COALESCE($4, provider_status),
         tx_hash = COALESCE($5, tx_hash),
         latest_event_id = $6,
         latest_event_type = $7,
         latest_event_detail = $8,
         latest_event_at = $9,
         updated_at = NOW()
     WHERE handoff_id = $1`,
    [
      input.handoffId,
      input.executionStatus,
      input.reconciliationStatus,
      input.providerStatus ?? null,
      input.txHash ?? null,
      event.eventId,
      input.eventType,
      input.detail ?? null,
      input.observedAt,
    ],
  );

  return mapEventRow(event);
}

export function createPostgresSettlementStore(pool: Pool): SettlementStore {
  const getHandoff = async (handoffId: string): Promise<SettlementHandoffRecord | null> => {
    const result = await pool.query<SettlementHandoffRow>(
      `SELECT
         handoff_id AS "handoffId",
         platform_id AS "platformId",
         platform_handoff_id AS "platformHandoffId",
         trade_id AS "tradeId",
         phase,
         settlement_channel AS "settlementChannel",
         display_currency AS "displayCurrency",
         display_amount AS "displayAmount",
         asset_symbol AS "assetSymbol",
         asset_amount AS "assetAmount",
         ricardian_hash AS "ricardianHash",
         external_reference AS "externalReference",
         metadata,
         execution_status AS "executionStatus",
         reconciliation_status AS "reconciliationStatus",
         callback_status AS "callbackStatus",
         provider_status AS "providerStatus",
         tx_hash AS "txHash",
         latest_event_id AS "latestEventId",
         latest_event_type AS "latestEventType",
         latest_event_detail AS "latestEventDetail",
         latest_event_at AS "latestEventAt",
         callback_delivered_at AS "callbackDeliveredAt",
         request_id AS "requestId",
         source_api_key_id AS "sourceApiKeyId",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM settlement_handoffs
       WHERE handoff_id = $1`,
      [handoffId],
    );

    return result.rows[0] ? mapHandoffRow(result.rows[0]) : null;
  };

  const getHandoffByPlatformRef = async (
    platformId: string,
    platformHandoffId: string,
  ): Promise<SettlementHandoffRecord | null> => {
    const result = await pool.query<SettlementHandoffRow>(
      `SELECT
         handoff_id AS "handoffId",
         platform_id AS "platformId",
         platform_handoff_id AS "platformHandoffId",
         trade_id AS "tradeId",
         phase,
         settlement_channel AS "settlementChannel",
         display_currency AS "displayCurrency",
         display_amount AS "displayAmount",
         asset_symbol AS "assetSymbol",
         asset_amount AS "assetAmount",
         ricardian_hash AS "ricardianHash",
         external_reference AS "externalReference",
         metadata,
         execution_status AS "executionStatus",
         reconciliation_status AS "reconciliationStatus",
         callback_status AS "callbackStatus",
         provider_status AS "providerStatus",
         tx_hash AS "txHash",
         latest_event_id AS "latestEventId",
         latest_event_type AS "latestEventType",
         latest_event_detail AS "latestEventDetail",
         latest_event_at AS "latestEventAt",
         callback_delivered_at AS "callbackDeliveredAt",
         request_id AS "requestId",
         source_api_key_id AS "sourceApiKeyId",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM settlement_handoffs
       WHERE platform_id = $1 AND platform_handoff_id = $2`,
      [platformId, platformHandoffId],
    );

    return result.rows[0] ? mapHandoffRow(result.rows[0]) : null;
  };

  return {
    async createHandoff(input) {
      const existing = await getHandoffByPlatformRef(input.platformId, input.platformHandoffId);
      if (existing) {
        return existing;
      }

      const handoffId = randomUUID();
      const result = await pool.query<SettlementHandoffRow>(
        `INSERT INTO settlement_handoffs (
           handoff_id,
           platform_id,
           platform_handoff_id,
           trade_id,
           phase,
           settlement_channel,
           display_currency,
           display_amount,
           asset_symbol,
           asset_amount,
           ricardian_hash,
           external_reference,
           metadata,
           execution_status,
           reconciliation_status,
           callback_status,
           request_id,
           source_api_key_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'pending', 'pending', 'pending', $14, $15)
         RETURNING
           handoff_id AS "handoffId",
           platform_id AS "platformId",
           platform_handoff_id AS "platformHandoffId",
           trade_id AS "tradeId",
           phase,
           settlement_channel AS "settlementChannel",
           display_currency AS "displayCurrency",
           display_amount AS "displayAmount",
           asset_symbol AS "assetSymbol",
           asset_amount AS "assetAmount",
           ricardian_hash AS "ricardianHash",
           external_reference AS "externalReference",
           metadata,
           execution_status AS "executionStatus",
           reconciliation_status AS "reconciliationStatus",
           callback_status AS "callbackStatus",
           provider_status AS "providerStatus",
           tx_hash AS "txHash",
           latest_event_id AS "latestEventId",
           latest_event_type AS "latestEventType",
           latest_event_detail AS "latestEventDetail",
           latest_event_at AS "latestEventAt",
           callback_delivered_at AS "callbackDeliveredAt",
           request_id AS "requestId",
           source_api_key_id AS "sourceApiKeyId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          handoffId,
          input.platformId,
          input.platformHandoffId,
          input.tradeId,
          input.phase,
          input.settlementChannel,
          input.displayCurrency,
          input.displayAmount.toFixed(2),
          input.assetSymbol ?? null,
          input.assetAmount === undefined || input.assetAmount === null
            ? null
            : input.assetAmount.toFixed(6),
          input.ricardianHash ?? null,
          input.externalReference ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.requestId,
          input.sourceApiKeyId ?? null,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new GatewayError(500, 'INTERNAL_ERROR', 'Failed to persist settlement handoff');
      }

      return mapHandoffRow(row);
    },

    getHandoff,
    getHandoffByPlatformRef,

    async listHandoffs(input) {
      const { clause, params } = buildHandoffFilterClause(input);

      const [rowsResult, summaryResult] = await Promise.all([
        pool.query<SettlementHandoffRow>(
          `SELECT
             handoff_id AS "handoffId",
             platform_id AS "platformId",
             platform_handoff_id AS "platformHandoffId",
             trade_id AS "tradeId",
             phase,
             settlement_channel AS "settlementChannel",
             display_currency AS "displayCurrency",
             display_amount AS "displayAmount",
             asset_symbol AS "assetSymbol",
             asset_amount AS "assetAmount",
             ricardian_hash AS "ricardianHash",
             external_reference AS "externalReference",
             metadata,
             execution_status AS "executionStatus",
             reconciliation_status AS "reconciliationStatus",
             callback_status AS "callbackStatus",
             provider_status AS "providerStatus",
             tx_hash AS "txHash",
             latest_event_id AS "latestEventId",
             latest_event_type AS "latestEventType",
             latest_event_detail AS "latestEventDetail",
             latest_event_at AS "latestEventAt",
             callback_delivered_at AS "callbackDeliveredAt",
             request_id AS "requestId",
             source_api_key_id AS "sourceApiKeyId",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
           FROM settlement_handoffs
           ${clause}
           ORDER BY updated_at DESC, handoff_id DESC
           LIMIT $${params.length + 1}
           OFFSET $${params.length + 2}`,
          [...params, String(input.limit), String(input.offset)],
        ),
        pool.query<{ total: string; sourceFreshAt: Date | null }>(
          `SELECT
             COUNT(*)::text AS total,
             MAX(updated_at) AS "sourceFreshAt"
           FROM settlement_handoffs
           ${clause}`,
          params,
        ),
      ]);

      const summary = summaryResult.rows[0];
      const total = Number(summary?.total ?? '0');
      if (!Number.isFinite(total)) {
        throw new GatewayError(500, 'INTERNAL_ERROR', 'Stored settlement total is invalid', {
          total: summary?.total,
        });
      }

      return {
        items: rowsResult.rows.map(mapHandoffRow),
        total,
        sourceFreshAt: summary?.sourceFreshAt ? summary.sourceFreshAt.toISOString() : null,
      };
    },

    async createExecutionEvent(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const handoffCheck = await client.query<{
          handoffId: string;
          executionStatus: SettlementExecutionStatus;
        }>(
          `SELECT
             handoff_id AS "handoffId",
             execution_status AS "executionStatus"
           FROM settlement_handoffs
           WHERE handoff_id = $1
           FOR UPDATE`,
          [input.handoffId],
        );
        if (!handoffCheck.rows[0]) {
          throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', {
            handoffId: input.handoffId,
          });
        }

        validateExecutionTransition(
          handoffCheck.rows[0].executionStatus,
          input.executionStatus,
          input.eventType,
        );

        const event = await createEventWithClient(client, input);
        await client.query('COMMIT');
        return event;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async listExecutionEvents(handoffId) {
      const result = await pool.query<SettlementExecutionEventRow>(
        `SELECT
           event_id AS "eventId",
           handoff_id AS "handoffId",
           event_type AS "eventType",
           execution_status AS "executionStatus",
           reconciliation_status AS "reconciliationStatus",
           provider_status AS "providerStatus",
           tx_hash AS "txHash",
           detail,
           metadata,
           observed_at AS "observedAt",
           request_id AS "requestId",
           source_api_key_id AS "sourceApiKeyId",
           created_at AS "createdAt"
         FROM settlement_execution_events
         WHERE handoff_id = $1
         ORDER BY observed_at DESC, event_id DESC`,
        [handoffId],
      );

      return result.rows.map(mapEventRow);
    },

    async queueCallbackDelivery(input) {
      const deliveryId = randomUUID();
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `INSERT INTO settlement_callback_deliveries (
           delivery_id,
           handoff_id,
           event_id,
           target_url,
           request_body,
           status,
           attempt_count,
           next_attempt_at,
           request_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, 0, $7, $8)
         RETURNING
           delivery_id AS "deliveryId",
           handoff_id AS "handoffId",
           event_id AS "eventId",
           target_url AS "targetUrl",
           request_body AS "requestBody",
           status,
           attempt_count AS "attemptCount",
           next_attempt_at AS "nextAttemptAt",
           last_attempted_at AS "lastAttemptedAt",
           delivered_at AS "deliveredAt",
           response_status AS "responseStatus",
           last_error AS "lastError",
           request_id AS "requestId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          deliveryId,
          input.handoffId,
          input.eventId,
          input.targetUrl,
          JSON.stringify(input.requestBody),
          input.status,
          input.nextAttemptAt,
          input.requestId,
        ],
      );

      if (input.status === 'disabled') {
        await pool.query(
          `UPDATE settlement_handoffs
           SET callback_status = 'disabled',
               updated_at = NOW()
           WHERE handoff_id = $1`,
          [input.handoffId],
        );
      }

      return mapDeliveryRow(result.rows[0]);
    },

    async getDueCallbackDeliveries(limit, now) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `SELECT
           delivery_id AS "deliveryId",
           handoff_id AS "handoffId",
           event_id AS "eventId",
           target_url AS "targetUrl",
           request_body AS "requestBody",
           status,
           attempt_count AS "attemptCount",
           next_attempt_at AS "nextAttemptAt",
           last_attempted_at AS "lastAttemptedAt",
           delivered_at AS "deliveredAt",
           response_status AS "responseStatus",
           last_error AS "lastError",
           request_id AS "requestId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM settlement_callback_deliveries
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= $1
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT $2`,
        [now, limit],
      );

      return result.rows.map(mapDeliveryRow);
    },

    async getCallbackDelivery(deliveryId) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `SELECT
           delivery_id AS "deliveryId",
           handoff_id AS "handoffId",
           event_id AS "eventId",
           target_url AS "targetUrl",
           request_body AS "requestBody",
           status,
           attempt_count AS "attemptCount",
           next_attempt_at AS "nextAttemptAt",
           last_attempted_at AS "lastAttemptedAt",
           delivered_at AS "deliveredAt",
           response_status AS "responseStatus",
           last_error AS "lastError",
           request_id AS "requestId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM settlement_callback_deliveries
         WHERE delivery_id = $1`,
        [deliveryId],
      );

      return result.rows[0] ? mapDeliveryRow(result.rows[0]) : null;
    },

    async markCallbackDelivering(deliveryId, attemptedAt) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `UPDATE settlement_callback_deliveries
         SET status = 'delivering',
             attempt_count = attempt_count + 1,
             last_attempted_at = $2,
             updated_at = NOW()
         WHERE delivery_id = $1
           AND status IN ('pending', 'failed')
         RETURNING
           delivery_id AS "deliveryId",
           handoff_id AS "handoffId",
           event_id AS "eventId",
           target_url AS "targetUrl",
           request_body AS "requestBody",
           status,
           attempt_count AS "attemptCount",
           next_attempt_at AS "nextAttemptAt",
           last_attempted_at AS "lastAttemptedAt",
           delivered_at AS "deliveredAt",
           response_status AS "responseStatus",
           last_error AS "lastError",
           request_id AS "requestId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [deliveryId, attemptedAt],
      );

      return result.rows[0] ? mapDeliveryRow(result.rows[0]) : null;
    },

    async markCallbackDelivered(deliveryId, completedAt, responseStatus) {
      await pool.query(
        `UPDATE settlement_callback_deliveries
         SET status = 'delivered',
             response_status = $3,
             delivered_at = $2,
             updated_at = NOW()
         WHERE delivery_id = $1`,
        [deliveryId, completedAt, responseStatus],
      );

      await pool.query(
        `UPDATE settlement_handoffs handoffs
         SET callback_status = 'delivered',
             callback_delivered_at = $2,
             updated_at = NOW()
         FROM settlement_callback_deliveries deliveries
         WHERE deliveries.delivery_id = $1
           AND handoffs.handoff_id = deliveries.handoff_id
           AND handoffs.latest_event_id = deliveries.event_id`,
        [deliveryId, completedAt],
      );
    },

    async markCallbackFailed(deliveryId, update) {
      await pool.query(
        `UPDATE settlement_callback_deliveries
         SET status = CASE WHEN $5 THEN 'dead_letter' ELSE 'failed' END,
             response_status = $3,
             last_error = $4,
             next_attempt_at = $6,
             updated_at = NOW()
         WHERE delivery_id = $1`,
        [
          deliveryId,
          update.attemptedAt,
          update.responseStatus ?? null,
          update.errorMessage,
          update.deadLetter,
          update.nextAttemptAt,
        ],
      );

      await pool.query(
        `UPDATE settlement_handoffs handoffs
         SET callback_status = CASE WHEN $2 THEN 'dead_letter' ELSE 'failed' END,
             updated_at = NOW()
         FROM settlement_callback_deliveries deliveries
         WHERE deliveries.delivery_id = $1
           AND handoffs.handoff_id = deliveries.handoff_id
           AND handoffs.latest_event_id = deliveries.event_id`,
        [deliveryId, update.deadLetter],
      );
    },

    async requeueCallbackDelivery(deliveryId, nextAttemptAt) {
      const result = await pool.query<SettlementCallbackDeliveryRow>(
        `UPDATE settlement_callback_deliveries
         SET status = 'pending',
             next_attempt_at = $2,
             updated_at = NOW()
         WHERE delivery_id = $1
           AND status = 'dead_letter'
         RETURNING
           delivery_id AS "deliveryId",
           handoff_id AS "handoffId",
           event_id AS "eventId",
           target_url AS "targetUrl",
           request_body AS "requestBody",
           status,
           attempt_count AS "attemptCount",
           next_attempt_at AS "nextAttemptAt",
           last_attempted_at AS "lastAttemptedAt",
           delivered_at AS "deliveredAt",
           response_status AS "responseStatus",
           last_error AS "lastError",
           request_id AS "requestId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [deliveryId, nextAttemptAt],
      );

      return result.rows[0] ? mapDeliveryRow(result.rows[0]) : null;
    },

    async getTradeSettlementProjectionMap(tradeIds) {
      if (tradeIds.length === 0) {
        return new Map();
      }

      const result = await pool.query<SettlementHandoffRow>(
        `SELECT DISTINCT ON (trade_id)
           handoff_id AS "handoffId",
           platform_id AS "platformId",
           platform_handoff_id AS "platformHandoffId",
           trade_id AS "tradeId",
           phase,
           settlement_channel AS "settlementChannel",
           display_currency AS "displayCurrency",
           display_amount AS "displayAmount",
           asset_symbol AS "assetSymbol",
           asset_amount AS "assetAmount",
           ricardian_hash AS "ricardianHash",
           external_reference AS "externalReference",
           metadata,
           execution_status AS "executionStatus",
           reconciliation_status AS "reconciliationStatus",
           callback_status AS "callbackStatus",
           provider_status AS "providerStatus",
           tx_hash AS "txHash",
           latest_event_id AS "latestEventId",
           latest_event_type AS "latestEventType",
           latest_event_detail AS "latestEventDetail",
           latest_event_at AS "latestEventAt",
           callback_delivered_at AS "callbackDeliveredAt",
           request_id AS "requestId",
           source_api_key_id AS "sourceApiKeyId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM settlement_handoffs
         WHERE trade_id = ANY($1::text[])
         ORDER BY trade_id, updated_at DESC, handoff_id DESC`,
        [tradeIds],
      );

      const map = new Map<string, TradeSettlementProjection>();
      for (const row of result.rows) {
        const handoff = mapHandoffRow(row);
        map.set(handoff.tradeId, {
          handoffId: handoff.handoffId,
          platformId: handoff.platformId,
          platformHandoffId: handoff.platformHandoffId,
          phase: handoff.phase,
          settlementChannel: handoff.settlementChannel,
          displayCurrency: handoff.displayCurrency,
          displayAmount: handoff.displayAmount,
          executionStatus: handoff.executionStatus,
          reconciliationStatus: handoff.reconciliationStatus,
          callbackStatus: handoff.callbackStatus,
          providerStatus: handoff.providerStatus,
          txHash: handoff.txHash,
          externalReference: handoff.externalReference,
          latestEventType: handoff.latestEventType,
          latestEventDetail: handoff.latestEventDetail,
          latestEventAt: handoff.latestEventAt,
          callbackDeliveredAt: handoff.callbackDeliveredAt,
          createdAt: handoff.createdAt,
          updatedAt: handoff.updatedAt,
        });
      }

      return map;
    },
  };
}

export function createGatewayServiceAuthNonceStore(pool: Pool) {
  return {
    async consume(apiKey: string, nonce: string, ttlSeconds: number): Promise<boolean> {
      await cleanupExpiredNonces(pool);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const result = await pool.query(
        `INSERT INTO service_auth_nonces (api_key, nonce, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (api_key, nonce) DO NOTHING`,
        [apiKey, nonce, expiresAt],
      );

      return result.rowCount === 1;
    },

    async close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export function createInMemorySettlementStore(
  initialHandoffs: SettlementHandoffRecord[] = [],
): SettlementStore {
  const handoffs = new Map(
    initialHandoffs.map((record) => [record.handoffId, structuredClone(record)]),
  );
  const platformIndex = new Map(
    initialHandoffs.map((record) => [
      `${record.platformId}:${record.platformHandoffId}`,
      record.handoffId,
    ]),
  );
  const events = new Map<string, SettlementExecutionEventRecord[]>();
  const deliveries = new Map<string, SettlementCallbackDeliveryRecord>();

  const byTrade = (tradeId: string) =>
    [...handoffs.values()]
      .filter((record) => record.tradeId === tradeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  return {
    async createHandoff(input) {
      const key = `${input.platformId}:${input.platformHandoffId}`;
      const existingId = platformIndex.get(key);
      if (existingId) {
        return structuredClone(handoffs.get(existingId)!);
      }

      const now = new Date().toISOString();
      const record: SettlementHandoffRecord = {
        handoffId: randomUUID(),
        platformId: input.platformId,
        platformHandoffId: input.platformHandoffId,
        tradeId: input.tradeId,
        phase: input.phase,
        settlementChannel: input.settlementChannel,
        displayCurrency: input.displayCurrency,
        displayAmount: input.displayAmount,
        assetSymbol: input.assetSymbol ?? null,
        assetAmount: input.assetAmount ?? null,
        ricardianHash: input.ricardianHash ?? null,
        externalReference: input.externalReference ?? null,
        metadata: structuredClone(input.metadata ?? {}),
        executionStatus: 'pending',
        reconciliationStatus: 'pending',
        callbackStatus: 'pending',
        providerStatus: null,
        txHash: null,
        latestEventId: null,
        latestEventType: null,
        latestEventDetail: null,
        latestEventAt: null,
        callbackDeliveredAt: null,
        requestId: input.requestId,
        sourceApiKeyId: input.sourceApiKeyId ?? null,
        createdAt: now,
        updatedAt: now,
      };

      handoffs.set(record.handoffId, record);
      platformIndex.set(key, record.handoffId);
      return structuredClone(record);
    },

    async getHandoff(handoffId) {
      const record = handoffs.get(handoffId);
      return record ? structuredClone(record) : null;
    },

    async getHandoffByPlatformRef(platformId, platformHandoffId) {
      const record = handoffs.get(platformIndex.get(`${platformId}:${platformHandoffId}`) ?? '');
      return record ? structuredClone(record) : null;
    },

    async listHandoffs(input) {
      const filtered = [...handoffs.values()]
        .filter((record) => (input.tradeId ? record.tradeId === input.tradeId : true))
        .filter((record) =>
          input.reconciliationStatus
            ? record.reconciliationStatus === input.reconciliationStatus
            : true,
        )
        .filter((record) =>
          input.executionStatus ? record.executionStatus === input.executionStatus : true,
        )
        .sort((left, right) => {
          const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
          if (updatedOrder !== 0) {
            return updatedOrder;
          }

          return right.handoffId.localeCompare(left.handoffId);
        });

      return {
        items: filtered
          .slice(input.offset, input.offset + input.limit)
          .map((record) => structuredClone(record)),
        total: filtered.length,
        sourceFreshAt: filtered[0]?.updatedAt ?? null,
      };
    },

    async createExecutionEvent(input) {
      const handoff = handoffs.get(input.handoffId);
      if (!handoff) {
        throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', {
          handoffId: input.handoffId,
        });
      }

      validateExecutionTransition(handoff.executionStatus, input.executionStatus, input.eventType);

      const event: SettlementExecutionEventRecord = {
        eventId: randomUUID(),
        handoffId: input.handoffId,
        eventType: input.eventType,
        executionStatus: input.executionStatus,
        reconciliationStatus: input.reconciliationStatus,
        providerStatus: input.providerStatus ?? null,
        txHash: input.txHash ?? null,
        detail: input.detail ?? null,
        metadata: structuredClone(input.metadata ?? {}),
        observedAt: input.observedAt,
        requestId: input.requestId,
        sourceApiKeyId: input.sourceApiKeyId ?? null,
        createdAt: new Date().toISOString(),
      };

      const bucket = events.get(input.handoffId) ?? [];
      bucket.unshift(event);
      events.set(input.handoffId, bucket);

      handoffs.set(input.handoffId, {
        ...handoff,
        executionStatus: input.executionStatus,
        reconciliationStatus: input.reconciliationStatus,
        callbackStatus: handoff.callbackStatus === 'disabled' ? 'disabled' : 'pending',
        providerStatus: input.providerStatus ?? handoff.providerStatus,
        txHash: input.txHash ?? handoff.txHash,
        latestEventId: event.eventId,
        latestEventType: input.eventType,
        latestEventDetail: input.detail ?? null,
        latestEventAt: input.observedAt,
        updatedAt: new Date().toISOString(),
      });

      return structuredClone(event);
    },

    async listExecutionEvents(handoffId) {
      return structuredClone(events.get(handoffId) ?? []);
    },

    async queueCallbackDelivery(input) {
      const record: SettlementCallbackDeliveryRecord = {
        deliveryId: randomUUID(),
        handoffId: input.handoffId,
        eventId: input.eventId,
        targetUrl: input.targetUrl,
        requestBody: structuredClone(input.requestBody),
        status: input.status,
        attemptCount: 0,
        nextAttemptAt: input.nextAttemptAt,
        lastAttemptedAt: null,
        deliveredAt: null,
        responseStatus: null,
        lastError: null,
        requestId: input.requestId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      deliveries.set(record.deliveryId, record);
      const handoff = handoffs.get(input.handoffId);
      if (handoff && input.status === 'disabled') {
        handoffs.set(input.handoffId, {
          ...handoff,
          callbackStatus: 'disabled',
          updatedAt: new Date().toISOString(),
        });
      }
      return structuredClone(record);
    },

    async getDueCallbackDeliveries(limit, now) {
      return [...deliveries.values()]
        .filter(
          (delivery) =>
            (delivery.status === 'pending' || delivery.status === 'failed') &&
            delivery.nextAttemptAt <= now,
        )
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
        .slice(0, limit)
        .map((delivery) => structuredClone(delivery));
    },

    async getCallbackDelivery(deliveryId) {
      const delivery = deliveries.get(deliveryId);
      return delivery ? structuredClone(delivery) : null;
    },

    async markCallbackDelivering(deliveryId, attemptedAt) {
      const delivery = deliveries.get(deliveryId);
      if (!delivery || (delivery.status !== 'pending' && delivery.status !== 'failed')) {
        return null;
      }

      const next = {
        ...delivery,
        status: 'delivering' as const,
        attemptCount: delivery.attemptCount + 1,
        lastAttemptedAt: attemptedAt,
        updatedAt: new Date().toISOString(),
      };
      deliveries.set(deliveryId, next);
      return structuredClone(next);
    },

    async markCallbackDelivered(deliveryId, completedAt, responseStatus) {
      const delivery = deliveries.get(deliveryId);
      if (!delivery) {
        return;
      }

      deliveries.set(deliveryId, {
        ...delivery,
        status: 'delivered',
        deliveredAt: completedAt,
        responseStatus,
        updatedAt: new Date().toISOString(),
      });
      const handoff = handoffs.get(delivery.handoffId);
      if (handoff && handoff.latestEventId === delivery.eventId) {
        handoffs.set(delivery.handoffId, {
          ...handoff,
          callbackStatus: 'delivered',
          callbackDeliveredAt: completedAt,
          updatedAt: new Date().toISOString(),
        });
      }
    },

    async markCallbackFailed(deliveryId, update) {
      const delivery = deliveries.get(deliveryId);
      if (!delivery) {
        return;
      }

      deliveries.set(deliveryId, {
        ...delivery,
        status: update.deadLetter ? 'dead_letter' : 'failed',
        responseStatus: update.responseStatus ?? null,
        lastError: update.errorMessage,
        nextAttemptAt: update.nextAttemptAt,
        updatedAt: new Date().toISOString(),
      });
      const handoff = handoffs.get(delivery.handoffId);
      if (handoff && handoff.latestEventId === delivery.eventId) {
        handoffs.set(delivery.handoffId, {
          ...handoff,
          callbackStatus: update.deadLetter ? 'dead_letter' : 'failed',
          updatedAt: new Date().toISOString(),
        });
      }
    },

    async requeueCallbackDelivery(deliveryId, nextAttemptAt) {
      const delivery = deliveries.get(deliveryId);
      if (!delivery || delivery.status !== 'dead_letter') {
        return null;
      }

      const next = {
        ...delivery,
        status: 'pending' as const,
        nextAttemptAt,
        updatedAt: new Date().toISOString(),
      };
      deliveries.set(deliveryId, next);
      const handoff = handoffs.get(delivery.handoffId);
      if (handoff && handoff.latestEventId === delivery.eventId) {
        handoffs.set(delivery.handoffId, {
          ...handoff,
          callbackStatus: 'pending',
          updatedAt: new Date().toISOString(),
        });
      }
      return structuredClone(next);
    },

    async getTradeSettlementProjectionMap(tradeIds) {
      const map = new Map<string, TradeSettlementProjection>();
      for (const tradeId of tradeIds) {
        const record = byTrade(tradeId);
        if (!record) {
          continue;
        }
        map.set(tradeId, {
          handoffId: record.handoffId,
          platformId: record.platformId,
          platformHandoffId: record.platformHandoffId,
          phase: record.phase,
          settlementChannel: record.settlementChannel,
          displayCurrency: record.displayCurrency,
          displayAmount: record.displayAmount,
          executionStatus: record.executionStatus,
          reconciliationStatus: record.reconciliationStatus,
          callbackStatus: record.callbackStatus,
          providerStatus: record.providerStatus,
          txHash: record.txHash,
          externalReference: record.externalReference,
          latestEventType: record.latestEventType,
          latestEventDetail: record.latestEventDetail,
          latestEventAt: record.latestEventAt,
          callbackDeliveredAt: record.callbackDeliveredAt,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
      return map;
    },
  };
}
